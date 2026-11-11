"""Optional real cross-language qualification; set WIKI_RAG_GATE_SOURCE to reviewed gate."""

import base64
import dataclasses
import json
import os
import subprocess
import tempfile
import threading
from pathlib import Path

import httpx
import pytest
from conftest import git, tracked
from test_engine import FakeProvider
from test_remote import remote_config

from wiki_rag import RagError
from wiki_rag.engine import run
from wiki_rag.remote_state import RemoteState


class Bridge(httpx.BaseTransport):
    def __init__(self, gate):
        self.directory = tempfile.TemporaryDirectory(prefix="wiki-rag-bridge-")
        self.process = subprocess.Popen(
            [
                "node",
                "--disable-warning=ExperimentalWarning",
                str(Path(__file__).with_name("workerd_bridge.mjs")),
                gate,
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            cwd=self.directory.name,
            env={**os.environ, "NODE_ENV": "test"},
        )
        assert json.loads(self.process.stdout.readline()) == {"ready": True}
        self.lock = threading.Lock()
        self.lose = None
        self.requests = []

    def exchange(self, item):
        with self.lock:
            self.process.stdin.write(json.dumps(item) + "\n")
            self.process.stdin.flush()
            result = json.loads(self.process.stdout.readline())
        assert "error" not in result, result
        return result

    def handle_request(self, request):
        self.requests.append(request.url.path)
        result = self.exchange(
            {
                "url": str(request.url),
                "method": request.method,
                "body": base64.b64encode(request.content).decode(),
            }
        )
        if self.lose and request.url.path.endswith(self.lose) and result["status"] == 200:
            self.lose = None
            raise httpx.ReadError("synthetic response lost")
        return httpx.Response(
            result["status"],
            headers=result.get("headers", {}),
            content=base64.b64decode(result["body"]),
        )

    def admin(self, route, body):
        result = self.exchange(
            {
                "url": "https://gate.example/admin/" + route,
                "method": "POST",
                "body": base64.b64encode(json.dumps(body).encode()).decode(),
                "admin": True,
            }
        )
        assert result["status"] == 200, result

    def shutdown(self):
        self.process.stdin.close()
        assert self.process.wait(timeout=20) == 0
        self.directory.cleanup()

    def complete(self, provider):
        result = self.exchange(
            {"control": "complete", "files": list(provider.attachments.values())}
        )
        jobs = json.loads(base64.b64decode(result["body"]))
        assert jobs and all(j["status"] == "complete" for j in jobs), jobs

    def tick(self, provider):
        result = self.exchange({"control": "tick", "files": list(provider.attachments.values())})
        return json.loads(base64.b64decode(result["body"]))


@pytest.fixture
def bridge(monkeypatch):
    gate = os.environ.get("WIKI_RAG_GATE_SOURCE")
    if not gate:
        pytest.skip("set WIKI_RAG_GATE_SOURCE for real workerd acceptance")
    transport = Bridge(gate)
    monkeypatch.setenv("GATE_ORIGIN", "https://gate.example")
    monkeypatch.setenv("ACCESS_ID", "synthetic-id")
    monkeypatch.setenv("ACCESS_SECRET", "synthetic-secret")
    transport.admin(
        "publisher",
        {"key": "service:one.access", "enabled": True, "grants": {"allow": ["*"], "deny": []}},
    )
    yield transport
    transport.shutdown()


def provision(bridge, cfg):
    bridge.admin(
        "ingestion",
        {
            "workspace": cfg.remote_state.workspace,
            "ownership": cfg.ownership,
            "binding": {
                "projectId": cfg.project_id,
                "credentialEnv": "QUERY_KEY",
                "stores": {c.name: c.vector_store_id for c in cfg.collections},
            },
        },
    )


def test_real_workerd_ephemeral_recovery_and_retirement(tmp_path, repo, bridge):
    tracked(repo, "a.md")
    git(repo, "commit", "-m", "first")
    cfg = remote_config(tmp_path, repo)
    provision(bridge, cfg)
    provider = FakeProvider()
    runs = [0]

    def invoke(command="index", apply=True):
        # Every invocation gets another full clone and no shared local state directory.
        runs[0] += 1
        root = tmp_path / f"runner-{runs[0]}"
        subprocess.run(
            ["git", "clone", "--no-local", "--branch", "main", str(repo), str(root)],
            check=True,
            capture_output=True,
        )
        fresh = dataclasses.replace(
            cfg, collections=(dataclasses.replace(cfg.collections[0], root=root),)
        )
        with RemoteState(fresh, transport=bridge) as remote:
            return run(fresh, command, apply=apply, provider=provider, remote=remote)

    with pytest.raises(RagError, match="uninitialized"):
        invoke("update")
    provider.unknown_upload = True
    with pytest.raises(RagError, match="unknown"):
        invoke()
    bridge.exchange({"control": "restart"})
    bridge.lose = "/checkpoint"
    initial = invoke()
    assert initial["mode"] == "submitted" and "publication_id" not in initial
    bridge.exchange({"control": "restart"})
    bridge.complete(provider)
    before = provider.uploads
    noop = invoke()
    assert noop["mode"] == "applied" and provider.uploads == before == 1
    assert invoke()["publication_id"] == noop["publication_id"]
    tracked(repo, "a.md", "second")
    git(repo, "commit", "-m", "second")
    bridge.lose = "/submit"
    invoke()
    bridge.complete(provider)
    invoke()
    assert provider.uploads == 2 and set(provider.files) == {"file-2"}
    git(repo, "mv", "a.md", "renamed.md")
    git(repo, "commit", "-m", "rename")
    invoke()
    bridge.complete(provider)
    invoke()
    assert set(provider.files) == {"file-3"}
    # Revert content/path: old operation must retire atomically, never reactivate old file.
    git(repo, "mv", "renamed.md", "a.md")
    tracked(repo, "a.md", "hello\n")
    git(repo, "commit", "-m", "restore first")
    invoke()
    bridge.complete(provider)
    invoke()
    assert set(provider.files) == {"file-4"}
    git(repo, "rm", "a.md")
    git(repo, "commit", "-m", "delete")
    invoke()
    bridge.complete(provider)
    invoke()
    assert not provider.files
    assert len(list(tmp_path.glob("runner-*"))) == runs[0]


def fresh_checkout(cfg, repo, destination):
    subprocess.run(
        ["git", "clone", "--no-local", "--branch", "main", str(repo), str(destination)],
        check=True,
        capture_output=True,
    )
    return dataclasses.replace(
        cfg, collections=(dataclasses.replace(cfg.collections[0], root=destination),)
    )


def test_real_workerd_takeover_stale_attempt_and_late_effect(tmp_path, repo, bridge):
    import uuid

    tracked(repo, "a.md")
    git(repo, "commit", "-m", "first")
    cfg = remote_config(tmp_path, repo)
    provision(bridge, cfg)
    provider = FakeProvider()
    upload = provider.upload
    delayed_effects = []
    publication = []
    ordering = []

    def delayed_upload(filename, content):
        # Dispatch reserves an ID but does not create the provider resource yet.
        provider.uploads += 1
        fid = f"file-{provider.uploads}"

        def arrive():
            provider.files[fid] = {
                "id": fid,
                "filename": filename,
                "bytes": len(content),
                "content": content,
                "object": "file",
            }
            ordering.append("old-effect-visible")

        delayed_effects.append(arrive)
        ordering.append("old-request-dispatched")
        assert fid not in provider.files
        bridge.exchange({"control": "restart", "expire": True})
        tracked(repo, "a.md", "newer")
        git(repo, "commit", "-m", "newer")
        next_cfg = fresh_checkout(cfg, repo, tmp_path / "successor")
        provider.upload = upload
        with RemoteState(next_cfg, transport=bridge) as successor:
            # New asynchronous submission cannot discard unresolved older ownership.
            with pytest.raises(RagError, match="unresolved upload"):
                run(next_cfg, "index", apply=True, provider=provider, remote=successor)
            assert successor.publication() is None
            from wiki_rag.engine import empty_manifest

            candidate = empty_manifest(next_cfg)
            candidate.update(generation=1, published_at="2026-01-01T00:00:00+00:00")
            candidate["collections"] = {
                "guide": {
                    **next_cfg.collections[0].binding(),
                    "repository_commit": git(repo, "rev-parse", "HEAD"),
                    "processing": next_cfg.processing,
                    "files": {},
                }
            }
            publication.append(candidate)
            pending = [item for page in successor.cleanup_pages() for item in page]
            old = next(
                item["operation"] for item in pending if item["operation"]["filename"] == filename
            )
            assert old["phase"] == "upload_pending"
            assert "file_id" not in old
            assert set(provider.files) == {"file-2"} and fid not in provider.files
            ordering.append("successor-fenced-effect-absent")
        return fid  # Old response cannot checkpoint into the successor epoch.

    provider.upload = delayed_upload
    initial_cfg = fresh_checkout(cfg, repo, tmp_path / "initial")
    stale = RemoteState(initial_cfg, transport=bridge)
    try:
        with pytest.raises(RagError, match="409"):
            run(initial_cfg, "index", apply=True, provider=provider, remote=stale)
        assert stale.poisoned and set(provider.files) == {"file-2"}
        # Also prove the server rejects a stale direct publish with otherwise valid content.
        with pytest.raises(RagError, match="409"):
            stale.request(
                "POST",
                "publish",
                {
                    **stale.proof(),
                    "expected_revision": stale.revision,
                    "request_id": str(uuid.uuid4()),
                    "manifestText": json.dumps(publication[0]),
                },
            )
        ordering.append("stale-checkpoint-and-publish-rejected")
    finally:
        stale.finish(suppress=True)

    absent_cfg = fresh_checkout(cfg, repo, tmp_path / "absent-retry")
    with RemoteState(absent_cfg, transport=bridge) as remote:
        with pytest.raises(RagError, match="unresolved upload"):
            run(absent_cfg, "index", apply=True, provider=provider, remote=remote)
        assert remote.publication() is None
        assert any(
            item["operation"]["phase"] == "upload_pending"
            for page in remote.cleanup_pages()
            for item in page
        )
    delayed_effects[0]()  # Late provider mutation arrives after the newer fenced attempt.
    assert set(provider.files) == {"file-1", "file-2"}
    final_cfg = fresh_checkout(cfg, repo, tmp_path / "arrival-cleanup")
    with RemoteState(final_cfg, transport=bridge) as remote:
        result = run(final_cfg, "index", apply=True, provider=provider, remote=remote)
        assert result["mode"] == "submitted" and remote.publication() is None
    bridge.complete(provider)
    with RemoteState(final_cfg, transport=bridge) as remote:
        result = run(final_cfg, "index", apply=True, provider=provider, remote=remote)
        assert result["publication_id"] == remote.publication()["publication_id"]
        assert list(remote.cleanup_pages()) == [[]]
    assert ordering == [
        "old-request-dispatched",
        "successor-fenced-effect-absent",
        "stale-checkpoint-and-publish-rejected",
        "old-effect-visible",
    ]
    assert set(provider.files) == {"file-2"} and provider.uploads == 2
    assert provider.attachment("vs_test", "file-2")["status"] == "completed"


def test_real_workerd_delayed_old_delete_cannot_target_replacement_attempt(tmp_path, repo, bridge):
    tracked(repo, "a.md")
    git(repo, "commit", "-m", "first")
    cfg = remote_config(tmp_path, repo)
    provision(bridge, cfg)
    provider = FakeProvider()
    delete = provider.delete_file
    queued = []
    first_cfg = fresh_checkout(cfg, repo, tmp_path / "first-runner")
    with RemoteState(first_cfg, transport=bridge) as remote:
        run(first_cfg, "index", apply=True, provider=provider, remote=remote)
    bridge.complete(provider)
    with RemoteState(first_cfg, transport=bridge) as remote:
        old = remote.publication()["collections"]["guide"]["files"]["a.md"]

    def delay_old_delete(fid):
        assert fid == old["file_id"]
        queued.append(lambda: delete(fid))
        raise RagError("unknown delayed delete outcome")

    provider.delete_file = delay_old_delete
    tracked(repo, "a.md", "replacement")
    git(repo, "commit", "-m", "replacement")
    replacement_cfg = fresh_checkout(cfg, repo, tmp_path / "replacement-runner")
    with RemoteState(replacement_cfg, transport=bridge) as remote:
        run(replacement_cfg, "index", apply=True, provider=provider, remote=remote)
    bridge.complete(provider)
    with RemoteState(replacement_cfg, transport=bridge) as remote:
        with pytest.raises(RagError, match="delayed delete"):
            run(replacement_cfg, "index", apply=True, provider=provider, remote=remote)
        assert (
            remote.lookup([old["operation_id"]])[old["operation_id"]]["phase"]
            == "file_delete_pending"
        )
    assert old["file_id"] in provider.files

    # Reintroduce the first logical version. Its previous ID must finish retirement
    # through an idempotent retry before a new attempt gets a distinct provider ID.
    provider.delete_file = delete
    tracked(repo, "a.md", "hello\n")
    git(repo, "commit", "-m", "restore first version")
    restored_cfg = fresh_checkout(cfg, repo, tmp_path / "restored-runner")
    with RemoteState(restored_cfg, transport=bridge) as remote:
        run(restored_cfg, "index", apply=True, provider=provider, remote=remote)
    bridge.complete(provider)
    with RemoteState(restored_cfg, transport=bridge) as remote:
        run(restored_cfg, "index", apply=True, provider=provider, remote=remote)
        published = remote.publication()
        restored = published["collections"]["guide"]["files"]["a.md"]
        assert restored["operation_id"] == old["operation_id"]
        assert restored["file_id"] != old["file_id"]
        assert old["file_id"] not in provider.files
        rows = remote.operations(after="", limit=100)["items"]
        retired = [row for row in rows if row["id"].startswith(old["operation_id"] + ".retired.")]
        assert len(retired) == 1 and retired[0]["operation"]["phase"] == "deleted"
        assert retired[0]["operation"]["file_id"] == old["file_id"]
        queued[0]()  # Original old-ID delete finally executes after replacement publication.
        assert remote.publication() == published
        assert set(provider.files) == {restored["file_id"]}
        assert provider.attachment("vs_test", restored["file_id"])["status"] == "completed"


def test_real_workerd_concurrent_initial_holders_and_lease_free_preview(tmp_path, repo, bridge):
    from concurrent.futures import ThreadPoolExecutor

    tracked(repo, "a.md")
    git(repo, "commit", "-m", "first")
    cfg = remote_config(tmp_path, repo)
    cfg = dataclasses.replace(
        cfg, remote_state=dataclasses.replace(cfg.remote_state, lease_wait_seconds=0)
    )
    provision(bridge, cfg)
    first = RemoteState(cfg, transport=bridge)
    second = RemoteState(cfg, transport=bridge)

    def acquire(remote):
        try:
            remote.acquire()
            return True
        except RagError:
            return False

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(acquire, [first, second]))
        assert sorted(results) == [False, True]
        with RemoteState(cfg, transport=bridge) as preview:
            result = run(cfg, "plan", remote=preview)
        assert result["collections"]["guide"]["changes"][0]["action"] == "add"
        assert first.epoch is not None or second.epoch is not None
    finally:
        first.finish(suppress=True)
        second.finish(suppress=True)


def test_real_workerd_background_pagination_survives_restart(tmp_path, repo, bridge):
    for n in range(101):
        tracked(repo, f"doc-{n}.md", f"Document {n}\n")
    git(repo, "commit", "-m", "documents")
    cfg = remote_config(tmp_path, repo)
    provision(bridge, cfg)
    provider = FakeProvider()
    with RemoteState(cfg, transport=bridge) as remote:
        result = run(cfg, "index", apply=True, provider=provider, remote=remote)
        assert result["mode"] == "submitted" and remote.publication() is None
    jobs = bridge.tick(provider)
    assert jobs[0]["status"] == "pending" and jobs[0]["completed"] == 100
    bridge.exchange({"control": "restart"})
    bridge.complete(provider)
    with RemoteState(cfg, transport=bridge) as remote:
        result = run(cfg, "index", apply=True, provider=provider, remote=remote)
        assert result["mode"] == "applied"
        assert len(remote.publication()["collections"]["guide"]["files"]) == 101
    assert provider.uploads == 101


def test_real_workerd_background_failure_preserves_prior_and_recovers(tmp_path, repo, bridge):
    tracked(repo, "a.md", "first")
    git(repo, "commit", "-m", "first")
    cfg = remote_config(tmp_path, repo)
    provision(bridge, cfg)
    provider = FakeProvider()
    with RemoteState(cfg, transport=bridge) as remote:
        run(cfg, "index", apply=True, provider=provider, remote=remote)
    bridge.complete(provider)
    with RemoteState(cfg, transport=bridge) as remote:
        prior = remote.publication()
    tracked(repo, "a.md", "second")
    git(repo, "commit", "-m", "second")
    with RemoteState(cfg, transport=bridge) as remote:
        run(cfg, "index", apply=True, provider=provider, remote=remote)
    provider.attachments["vs_test", "file-2"]["status"] = "failed"
    assert bridge.tick(provider)[0]["status"] == "failed"
    with RemoteState(cfg, transport=bridge) as remote:
        assert remote.publication() == prior
        assert (
            run(cfg, "index", apply=True, provider=provider, remote=remote)["mode"] == "submitted"
        )
    bridge.complete(provider)
    with RemoteState(cfg, transport=bridge) as remote:
        run(cfg, "index", apply=True, provider=provider, remote=remote)
        assert remote.publication() != prior
    assert provider.uploads == 3 and set(provider.files) == {"file-3"}


def test_real_workerd_mixed_derived_origins_are_immutable_and_background_verified(
    tmp_path, repo, bridge
):
    from test_derived_sources import PDF, SCRIPT, configured, pointer

    tracked(repo, "input.md", "documentation")
    tracked(repo, "generate.py", SCRIPT)
    tracked(repo, "paper.pdf", pointer())
    git(repo, "commit", "-m", "derived sources")
    (repo / "paper.pdf").write_bytes(PDF)
    cfg = configured(tmp_path, repo, lfs=True, script=SCRIPT)
    provision(bridge, cfg)
    provider = FakeProvider()
    remote = RemoteState(cfg, transport=bridge)
    try:
        result = run(cfg, "index", apply=True, provider=provider, remote=remote)
        assert result["mode"] == "submitted"
        rows = remote.operations(after="", limit=100)["items"]
        generated = next(
            x for x in rows if x["operation"].get("origin", {}).get("kind") == "generated"
        )
        corrupted = json.loads(json.dumps(generated["operation"]))
        corrupted["origin"]["inputs_sha256"] = "f" * 64
        with pytest.raises(RagError, match="409"):
            remote.checkpoint(generated["id"], corrupted)
    finally:
        remote.finish(suppress=True)
    bridge.exchange({"control": "restart", "expire": True})
    bridge.complete(provider)
    with RemoteState(cfg, transport=bridge) as remote:
        manifest = remote.publication()
        files = manifest["collections"]["guide"]["files"]
        assert files["paper.pdf"]["origin"]["kind"] == "git-lfs"
        assert files["docs/llm/api/api.md"]["origin"]["kind"] == "generated"
        assert "origin" not in files["input.md"]
        assert run(cfg, "index", apply=True, provider=provider, remote=remote)["mode"] == "applied"
    assert provider.uploads == 3
