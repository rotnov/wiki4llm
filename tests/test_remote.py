import dataclasses
import json

import httpx
import pytest
from conftest import config_file, git, tracked

from wiki_rag import RagError, load_config
from wiki_rag.selection import scan


def remote_config(tmp_path, repo):
    path = config_file(tmp_path, repo, collection_extra='branch = "main"')
    path.write_text(
        path.read_text().replace(
            'state = ".state"',
            '''[remote_state]
origin_env = "GATE_ORIGIN"
workspace = "team-docs"
client_id_env = "ACCESS_ID"
client_secret_env = "ACCESS_SECRET"''',
        )
    )
    return load_config(path)


def test_remote_config_mutually_exclusive(tmp_path, repo):
    cfg = remote_config(tmp_path, repo)
    assert cfg.state is None
    assert cfg.remote_state.workspace == "team-docs"
    assert cfg.remote_state.lease_wait_seconds == 300
    path = tmp_path / "wiki-rag.toml"
    path.write_text(path.read_text().replace("version = 1", 'version = 1\nstate = ".state"'))
    with pytest.raises(RagError, match="exactly one"):
        load_config(path)


def test_remote_source_requires_committed_literal_bytes(tmp_path, repo):
    tracked(repo, "a.md")
    cfg = remote_config(tmp_path, repo)
    with pytest.raises(RagError, match="committed"):
        scan(cfg)
    git(repo, "commit", "-m", "first")
    assert scan(cfg)["guide"].files["a.md"].source_commit
    (repo / "a.md").write_text("dirty")
    with pytest.raises(RagError, match="literal"):
        scan(cfg)
    (repo / "a.md").unlink()
    with pytest.raises(RagError, match="removed"):
        scan(cfg)


def test_remote_source_rejects_index_drift_without_filters(tmp_path, repo):
    tracked(repo, "a.md")
    git(repo, "commit", "-m", "first")
    cfg = remote_config(tmp_path, repo)
    marker = tmp_path / "executed"
    command = f"touch {marker}"
    git(repo, "config", "diff.external", command)
    git(repo, "config", "diff.evil.textconv", command)
    git(repo, "config", "filter.evil.clean", command)
    git(repo, "config", "filter.evil.process", command)
    (repo / ".git" / "info" / "attributes").write_text("*.md diff=evil filter=evil\n")
    assert scan(cfg)["guide"].files
    assert not marker.exists()
    git(repo, "update-index", "--force-remove", "a.md")
    with pytest.raises(RagError, match="index"):
        scan(cfg)
    assert not marker.exists()


def test_provider_guard_runs_again_after_delete_backoff(tmp_path, repo, monkeypatch):
    from wiki_rag.provider import OpenAIProvider

    cfg = load_config(config_file(tmp_path, repo))
    monkeypatch.setenv(cfg.api_key_env, "synthetic")
    calls = []
    healthy = [True]

    def guard():
        if not healthy[0]:
            raise RagError("lease lost")

    def handle(request):
        calls.append(request)
        return httpx.Response(503)

    def sleep(seconds):
        healthy[0] = False

    with OpenAIProvider(cfg, transport=httpx.MockTransport(handle), sleep=sleep) as provider:
        provider.mutation_guard = guard
        with pytest.raises(RagError, match="lease lost"):
            provider.delete_file("file-test")
    assert len(calls) == 1


class Authority:
    """Small deterministic transport fixture; workerd acceptance tests real validation."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.revision = 0
        self.initialized = False
        self.ops = {}
        self.manifest = None
        self.pending = None
        self.epoch = 0
        self.held = False
        self.requests = []
        self.receipts = {}
        self.lose = None
        self.fail = None

    def metadata(self):
        return {
            "features": ["async-submit-v1"],
            "workspace": "team-docs",
            "revision": self.revision,
            "initialized": self.initialized,
            "ownership": self.cfg.ownership,
            "binding": {
                "projectId": self.cfg.project_id,
                "credentialEnv": "QUERY_KEY",
                "stores": {c.name: c.vector_store_id for c in self.cfg.collections},
            },
            "publication": None,
            "operation_count": len(self.ops),
        }

    def handle(self, request):
        import hashlib

        path = request.url.path.rsplit("/", 1)[-1]
        body = json.loads(request.content) if request.content else {}
        self.requests.append((path, body))
        if self.fail == path:
            return httpx.Response(409, json={"error": 409})
        if path == "lease":
            if body["action"] == "acquire":
                if self.held:
                    return httpx.Response(409, headers={"Retry-After": "1"})
                self.epoch += 1
                self.held = True
            elif body["epoch"] != self.epoch:
                return httpx.Response(409)
            if body["action"] == "release":
                self.held = False
            return httpx.Response(
                200, json={"epoch": self.epoch, "expires_at": 120000, "server_time": 0}
            )
        if path in {"status", "snapshot"}:
            return httpx.Response(200, json=self.metadata())
        if path == "publication":
            if not self.manifest:
                return httpx.Response(200, content=b"null")
            data = json.dumps({"manifest": self.manifest, **self.metadata()["binding"]}).encode()
            if "part" in request.url.params:
                return httpx.Response(200, content=data)
            return httpx.Response(
                200,
                json={
                    "generation": "o-" + hashlib.sha256(data).hexdigest(),
                    "parts": 1,
                    "bytes": len(data),
                    "digest": hashlib.sha256(data).hexdigest(),
                },
            )
        assert body["epoch"] == self.epoch
        if path == "operations":
            assert body["revision"] == self.revision
            if "ids" in body:
                assert len(body["ids"]) <= 50
                ids = [i for i in body["ids"] if i in self.ops]
                nxt = None
            else:
                active = {
                    f["operation_id"]
                    for c in (self.manifest or {}).get("collections", {}).values()
                    for f in c["files"].values()
                }
                ids = sorted(
                    i
                    for i, op in self.ops.items()
                    if i > body.get("after", "")
                    and (not body.get("cleanup") or (i not in active and op["phase"] != "deleted"))
                )
                nxt = ids[99] if len(ids) > 100 else None
                ids = ids[:100]
            return httpx.Response(
                200,
                json={
                    "revision": self.revision,
                    "items": [{"id": i, "operation": self.ops[i]} for i in ids],
                    "next": nxt,
                },
            )
        rid = body["request_id"]
        if rid in self.receipts:
            return httpx.Response(200, json=self.receipts[rid])
        assert body["expected_revision"] == self.revision
        if path == "initialize":
            self.initialized = True
        elif path == "checkpoint":
            for item in body.get("retire", []):
                self.ops[item["retired_id"]] = self.ops.pop(item["id"])
            for item in body["upserts"]:
                self.ops[item["id"]] = item["operation"]
        elif path == "publish":
            self.manifest = json.loads(body["manifestText"])
        elif path == "submit":
            self.pending = json.loads(body["manifestText"])
        else:
            raise AssertionError(path)
        self.revision += 1
        result = {
            "revision": self.revision,
            "initialized": self.initialized,
            "generation": "o-" + "a" * 64,
        }
        if path == "submit":
            result["job_id"] = self.pending["publication_id"]
        self.receipts[rid] = result
        if self.lose == path:
            self.lose = None
            raise httpx.ReadError("synthetic lost response")
        return httpx.Response(200, json=result)

    def complete(self, provider):
        """Explicit test-server completion event, separate from client execution."""
        assert self.pending is not None
        for collection in self.pending["collections"].values():
            for entry in collection["files"].values():
                op = self.ops[entry["operation_id"]]
                assert op["phase"] in {"attached", "complete"}
                assert provider.attachments[op["store"], op["file_id"]]["status"] == "completed"
                op["phase"] = "complete"
        self.manifest = self.pending
        self.pending = None
        self.revision += 1


def backend(cfg, authority, monkeypatch, **kwargs):
    import wiki_rag.remote_state as module

    monkeypatch.setenv("GATE_ORIGIN", "https://gate.example")
    monkeypatch.setenv("ACCESS_ID", "synthetic-id")
    monkeypatch.setenv("ACCESS_SECRET", "synthetic-secret")
    return module.RemoteState(cfg, transport=httpx.MockTransport(authority.handle), **kwargs)


def test_remote_backend_exists():
    import importlib.util

    assert importlib.util.find_spec("wiki_rag.remote_state"), "remote backend is missing"


def test_lease_monotonic_expiry_poison_and_lost_checkpoint(tmp_path, repo, monkeypatch):
    cfg = remote_config(tmp_path, repo)
    authority = Authority(cfg)
    now = [0.0]
    with (
        pytest.raises(RagError, match="lease"),
        backend(cfg, authority, monkeypatch, monotonic=lambda: now[0]) as remote,
    ):
        remote.acquire()
        remote.load()
        authority.lose = "initialize"
        remote.command("initialize")
        assert remote.revision == 1 == authority.revision
        now[0] = 121.0
        with pytest.raises(RagError, match="lease"):
            remote.guard()
        now[0] = 0.0
        with pytest.raises(RagError, match="lease"):
            remote.guard()


def test_remote_engine_ephemeral_noop_changes_and_pending_recovery(tmp_path, repo, monkeypatch):
    from test_engine import FakeProvider

    from wiki_rag.engine import run

    tracked(repo, "a.md")
    git(repo, "commit", "-m", "first")
    cfg = remote_config(tmp_path, repo)
    authority = Authority(cfg)
    provider = FakeProvider()

    def invoke(command="index", apply=True):
        with backend(cfg, authority, monkeypatch) as remote:
            result = run(cfg, command, apply=apply, provider=provider, remote=remote)
        if result["mode"] == "submitted":
            authority.complete(provider)
        return result

    provider.unknown_upload = True
    with pytest.raises(RagError, match="unknown"):
        invoke()
    invoke()
    first = authority.manifest
    invoke()
    assert authority.manifest == first and provider.uploads == 1
    preview = invoke("plan", False)
    assert preview["network_requests"] > 0
    assert not (tmp_path / ".state").exists()
    tracked(repo, "a.md", "second")
    git(repo, "commit", "-m", "second")
    authority.lose = "submit"
    invoke()
    invoke()
    assert provider.uploads == 2 and set(provider.files) == {"file-2"}
    git(repo, "mv", "a.md", "renamed.md")
    git(repo, "commit", "-m", "rename")
    invoke()
    invoke()
    assert provider.uploads == 3 and set(provider.files) == {"file-3"}
    git(repo, "rm", "renamed.md")
    git(repo, "commit", "-m", "delete")
    invoke()
    invoke()
    assert not provider.files


def test_remote_submission_conflict_preserves_previous_publication(tmp_path, repo, monkeypatch):
    from test_engine import FakeProvider

    from wiki_rag.engine import run

    tracked(repo, "a.md")
    git(repo, "commit", "-m", "first")
    cfg = remote_config(tmp_path, repo)
    authority, provider = Authority(cfg), FakeProvider()
    with backend(cfg, authority, monkeypatch) as remote:
        run(cfg, "index", apply=True, provider=provider, remote=remote)
    authority.complete(provider)
    before = authority.manifest
    tracked(repo, "a.md", "second")
    git(repo, "commit", "-m", "second")
    authority.fail = "submit"
    with pytest.raises(RagError, match="lease"), backend(cfg, authority, monkeypatch) as remote:
        with pytest.raises(RagError, match="409"):
            run(cfg, "index", apply=True, provider=provider, remote=remote)
    assert authority.manifest == before and provider.deleted == []


@pytest.mark.parametrize(
    "origin",
    [
        "http://gate.example",
        "https://u:p@gate.example",
        "https://gate.example/",
        "https://gate.example?q=1",
        "https://gate.example#frag",
        "https://gate.example\\evil",
    ],
)
def test_origin_validation(tmp_path, repo, monkeypatch, origin):
    from wiki_rag.remote_state import RemoteState

    cfg = remote_config(tmp_path, repo)
    monkeypatch.setenv("GATE_ORIGIN", origin)
    with pytest.raises(RagError, match="origin"):
        RemoteState(cfg)


def test_heartbeat_failure_permanently_poisoned(tmp_path, repo, monkeypatch):
    import time

    cfg = remote_config(tmp_path, repo)
    authority = Authority(cfg)
    with (
        pytest.raises(RagError, match="lease"),
        backend(cfg, authority, monkeypatch, heartbeat_seconds=0.01) as remote,
    ):
        remote.acquire()
        authority.fail = "lease"
        deadline = time.monotonic() + 2
        while not remote.poisoned and time.monotonic() < deadline:
            time.sleep(0.005)
        assert remote.poisoned
        authority.fail = None
        with pytest.raises(RagError, match="lease"):
            remote.guard()
        with pytest.raises(RagError, match="reacquire"):
            remote.acquire()


def test_contention_timeout_never_reads_stale_state(tmp_path, repo, monkeypatch):
    cfg = remote_config(tmp_path, repo)
    cfg = dataclasses.replace(
        cfg, remote_state=dataclasses.replace(cfg.remote_state, lease_wait_seconds=0)
    )
    authority = Authority(cfg)
    with backend(cfg, authority, monkeypatch) as first:
        first.acquire()
        with backend(cfg, authority, monkeypatch) as second:
            with pytest.raises(RagError, match="timed out"):
                second.acquire()
    assert all(path == "lease" for path, _ in authority.requests)


def test_preview_holding_lease_and_generation_restart(tmp_path, repo, monkeypatch):
    from test_engine import FakeProvider

    from wiki_rag.engine import run

    tracked(repo, "a.md")
    git(repo, "commit", "-m", "first")
    cfg = remote_config(tmp_path, repo)
    authority = Authority(cfg)
    provider = FakeProvider()
    with backend(cfg, authority, monkeypatch) as remote:
        run(cfg, "index", apply=True, provider=provider, remote=remote)
    authority.complete(provider)
    original = authority.handle
    changed = [False]

    def handle(request):
        if "part" in request.url.params and not changed[0]:
            changed[0] = True
            return httpx.Response(409)
        return original(request)

    authority.handle = handle
    with backend(cfg, authority, monkeypatch) as holder:
        holder.acquire()
        count = len(authority.requests)
        with backend(cfg, authority, monkeypatch) as preview:
            result = run(cfg, "plan", remote=preview)
        assert result["collections"]["guide"]["changes"] == []
        assert not any(path == "lease" for path, _ in authority.requests[count:])
        assert changed[0]


def test_large_history_streamed_without_client_cache(tmp_path, repo, monkeypatch):
    cfg = remote_config(tmp_path, repo)
    authority = Authority(cfg)
    # Dense history generated by the server fixture, not retained by RemoteState.
    original = authority.handle
    pages = []

    def handle(request):
        if request.url.path.endswith("/operations"):
            body = json.loads(request.content)
            start = int(body.get("after") or "0", 16) + 1
            count = min(100, 10000 - start + 1)
            items = [
                {"id": f"{i:064x}", "operation": {"phase": "uploaded"}}
                for i in range(start, start + max(count, 0))
            ]
            nxt = items[-1]["id"] if start + count <= 10000 else None
            pages.append(count)
            return httpx.Response(200, json={"revision": 0, "items": items, "next": nxt})
        return original(request)

    authority.handle = handle
    with backend(cfg, authority, monkeypatch) as remote:
        remote.acquire()
        assert sum(len(page) for page in remote.cleanup_pages()) == 10000
        assert not hasattr(remote, "cache") and not hasattr(remote, "operations_history")
    assert len(pages) == 100 and max(pages) == 100


def test_shallow_and_stale_sources_before_provider_writes(tmp_path, repo, monkeypatch):
    from test_engine import FakeProvider

    from wiki_rag.engine import run

    tracked(repo, "a.md")
    git(repo, "commit", "-m", "first")
    old = git(repo, "rev-parse", "HEAD")
    tracked(repo, "a.md", "second")
    git(repo, "commit", "-m", "second")
    cfg = remote_config(tmp_path, repo)
    authority, provider = Authority(cfg), FakeProvider()
    with backend(cfg, authority, monkeypatch) as remote:
        run(cfg, "index", apply=True, provider=provider, remote=remote)
    authority.complete(provider)
    git(repo, "reset", "--hard", old)
    with backend(cfg, authority, monkeypatch) as remote:
        with pytest.raises(RagError, match="stale"):
            run(cfg, "index", apply=True, provider=provider, remote=remote)
    assert provider.uploads == 1
    (repo / ".git" / "shallow").write_text(old + "\n")
    with pytest.raises(RagError, match="full Git history"):
        scan(cfg)


def test_obsolete_unknown_upload_fails_before_submission(tmp_path, repo, monkeypatch):
    from test_engine import FakeProvider

    from wiki_rag.engine import run

    tracked(repo, "a.md")
    git(repo, "commit", "-m", "first")
    cfg = remote_config(tmp_path, repo)
    authority, provider = Authority(cfg), FakeProvider()
    upload = provider.upload
    provider.upload = lambda *args: (_ for _ in ()).throw(RagError("unknown"))
    with backend(cfg, authority, monkeypatch) as remote:
        with pytest.raises(RagError, match="unknown"):
            run(cfg, "index", apply=True, provider=provider, remote=remote)
    provider.upload = upload
    tracked(repo, "a.md", "second")
    git(repo, "commit", "-m", "second")
    with backend(cfg, authority, monkeypatch) as remote:
        with pytest.raises(RagError, match="unresolved"):
            run(cfg, "index", apply=True, provider=provider, remote=remote)
    assert any(op["phase"] == "upload_pending" for op in authority.ops.values())
    assert provider.uploads == 1


def test_remote_invalid_gate_path_rejected_during_scan(tmp_path, repo):
    tracked(repo, "a#b.md")
    git(repo, "commit", "-m", "first")
    cfg = remote_config(tmp_path, repo)
    with pytest.raises(RagError, match="remote document path"):
        scan(cfg)


def test_preflight_accepts_gate_sized_ten_thousand_small_entries(tmp_path, repo):
    from wiki_rag.remote_engine import prospective_bounds
    from wiki_rag.selection import Snapshot, SourceFile

    cfg = remote_config(tmp_path, repo)
    files = {
        f"{i}.md": SourceFile(f"{i}.md", b"x", "a" * 64, "b" * 64, "md", "c" * 40, "utf8-text-v1")
        for i in range(10000)
    }
    prospective_bounds(cfg, {"guide": Snapshot(files, [], "c" * 40)})


def test_submission_acknowledged_then_lease_poison_never_claims_publication(
    tmp_path, repo, monkeypatch
):
    from test_engine import FakeProvider

    from wiki_rag.engine import run

    tracked(repo, "a.md")
    git(repo, "commit", "-m", "first")
    cfg = remote_config(tmp_path, repo)
    authority = Authority(cfg)
    original = authority.handle
    holder = []

    def handle(request):
        result = original(request)
        if request.url.path.endswith("/submit"):
            holder[0].poison()
        return result

    authority.handle = handle
    with pytest.raises(RagError, match="lease"), backend(cfg, authority, monkeypatch) as remote:
        holder.append(remote)
        with pytest.raises(RagError, match="lease"):
            run(cfg, "index", apply=True, provider=FakeProvider(), remote=remote)
    assert authority.manifest is None and authority.pending is not None


def test_remote_config_missing_mode_and_wait_bounds(tmp_path, repo):
    path = config_file(tmp_path, repo)
    path.write_text(path.read_text().replace('state = ".state"', ""))
    with pytest.raises(RagError, match="exactly one"):
        load_config(path)
    remote_config(tmp_path, repo)
    path.write_text(
        path.read_text().replace("[remote_state]", "[remote_state]\nlease_wait_seconds = 1801")
    )
    with pytest.raises(RagError, match="bounds"):
        load_config(path)


def test_remote_duplicate_logical_source_rejected_before_upload(tmp_path, repo):
    tracked(repo, "a.md")
    git(repo, "commit", "-m", "first")
    cfg = remote_config(tmp_path, repo)
    second = dataclasses.replace(cfg.collections[0], name="second", vector_store_id="vs_second")
    cfg = dataclasses.replace(cfg, collections=(*cfg.collections, second))
    from wiki_rag.remote_engine import prospective_bounds

    with pytest.raises(RagError, match="duplicate logical"):
        prospective_bounds(cfg, scan(cfg))


def test_finish_rejects_poisoned_attempt(tmp_path, repo, monkeypatch):
    cfg = remote_config(tmp_path, repo)
    remote = backend(cfg, Authority(cfg), monkeypatch)
    remote.acquire()
    remote.poison()
    with pytest.raises(RagError, match="lease"):
        remote.finish()


def test_single_renew_transport_failure_poison_without_retry(tmp_path, repo, monkeypatch):
    cfg = remote_config(tmp_path, repo)
    authority = Authority(cfg)
    original = authority.handle
    calls = []

    def handle(request):
        body = json.loads(request.content)
        if body.get("action") == "renew":
            calls.append(request)
            if len(calls) == 1:
                raise httpx.ReadError("renewal response lost")
        return original(request)

    authority.handle = handle
    remote = backend(cfg, authority, monkeypatch)
    try:
        remote.acquire()
        with pytest.raises(RagError):
            remote.renew()
        assert remote.poisoned and len(calls) == 1
    finally:
        remote.finish(suppress=True)


def test_remote_cli_parser_uses_authority_and_reports_network(tmp_path, repo, monkeypatch, capsys):
    from wiki_rag import cli, remote_engine

    cfg = remote_config(tmp_path, repo)
    authority = Authority(cfg)
    monkeypatch.setattr(
        remote_engine, "RemoteState", lambda config: backend(config, authority, monkeypatch)
    )
    assert cli.main(["status", "--config", str(tmp_path / "wiki-rag.toml")]) == 0
    output = json.loads(capsys.readouterr().out)
    assert output["network_requests"] == 2 and output["initialized"] is False
    assert cli.main(["update", "--apply", "--config", str(tmp_path / "wiki-rag.toml")]) == 2
    assert "uninitialized" in capsys.readouterr().err


@pytest.mark.parametrize("damage", ["digest", "bytes", "parts", "chunk"])
def test_publication_transport_bounds_and_digest(tmp_path, repo, monkeypatch, damage):
    import hashlib

    cfg = remote_config(tmp_path, repo)
    authority = Authority(cfg)
    original = authority.handle
    data = b"{}"

    def handle(request):
        if request.url.path.endswith("publication"):
            if "part" in request.url.params:
                return httpx.Response(
                    200, content=b"x" * (900 * 1024 + 1) if damage == "chunk" else data
                )
            return httpx.Response(
                200,
                json={
                    "generation": "o-" + "a" * 64,
                    "parts": 17 if damage == "parts" else 1,
                    "bytes": 9 * 1024 * 1024 + 1 if damage == "bytes" else len(data),
                    "digest": "a" * 64 if damage == "digest" else hashlib.sha256(data).hexdigest(),
                },
            )
        return original(request)

    authority.handle = handle
    with backend(cfg, authority, monkeypatch) as remote:
        with pytest.raises(RagError, match="bound|digest"):
            remote.publication()


def test_operation_lookup_and_page_response_bounds(tmp_path, repo, monkeypatch):
    cfg = remote_config(tmp_path, repo)
    authority = Authority(cfg)
    with pytest.raises(RagError, match="lease"), backend(cfg, authority, monkeypatch) as remote:
        remote.acquire()
        with pytest.raises(RagError, match="1..50"):
            remote.lookup([f"{i:064x}" for i in range(51)])
        original = authority.handle

        def handle(request):
            if request.url.path.endswith("operations"):
                return httpx.Response(200, content=b" " * (512 * 1024 + 1))
            return original(request)

        remote.client.close()
        remote.client = httpx.Client(
            base_url="https://gate.example/ingest/team-docs/", transport=httpx.MockTransport(handle)
        )
        with pytest.raises(RagError, match="size bound"):
            remote.lookup(["a" * 64])
        assert remote.poisoned


def substitute_source(repo, tmp_path, substitution):
    source = repo / "docs" / "a.md"
    if substitution == "file_symlink":
        target = tmp_path / "target.md"
        target.write_bytes(source.read_bytes())
        source.unlink()
        source.symlink_to(target)
    elif substitution == "directory_symlink":
        target = tmp_path / "target-docs"
        (repo / "docs").rename(target)
        (repo / "docs").symlink_to(target, target_is_directory=True)
    elif substitution == "nested_directory":
        (repo / "docs" / ".git").mkdir()
    elif substitution == "nested_file":
        (repo / "docs" / ".git").write_text("gitdir: nonexistent\n")
    else:
        source.write_bytes(
            {
                "binary": b"\x00binary",
                "lfs": b"version https://git-lfs.github.com/spec/v1\n",
                "secret": b"-----BEGIN " + b"PRIVATE KEY-----\n",
            }[substitution]
        )


@pytest.mark.parametrize(
    "substitution",
    [
        "file_symlink",
        "directory_symlink",
        "nested_directory",
        "nested_file",
        "binary",
        "lfs",
        "secret",
    ],
)
@pytest.mark.parametrize("omit_extensions", [False, True])
def test_remote_uncommitted_substitution_cannot_publish_deletion(
    tmp_path, repo, monkeypatch, substitution, omit_extensions
):
    from test_engine import FakeProvider

    from wiki_rag.engine import run

    tracked(repo, "docs/a.md")
    git(repo, "commit", "-m", "first")
    cfg = remote_config(tmp_path, repo)
    if omit_extensions:
        path = tmp_path / "wiki-rag.toml"
        path.write_text(path.read_text().replace('extensions = [".md", ".rst", ".pdf"]', ""))
        cfg = load_config(path)
    authority, provider = Authority(cfg), FakeProvider()
    with backend(cfg, authority, monkeypatch) as remote:
        run(cfg, "index", apply=True, provider=provider, remote=remote)
    authority.complete(provider)
    before = json.loads(json.dumps(authority.manifest))
    revision = authority.revision
    substitute_source(repo, tmp_path, substitution)
    with backend(cfg, authority, monkeypatch) as remote:
        with pytest.raises(RagError, match="selected committed source|literal HEAD"):
            run(cfg, "index", apply=True, provider=provider, remote=remote)
    assert authority.manifest == before and authority.revision == revision
    assert provider.uploads == 1 and provider.deleted == []


@pytest.mark.parametrize(
    "substitution", ["file_symlink", "directory_symlink", "nested_directory", "nested_file"]
)
def test_local_working_substitution_retains_skip_behavior(tmp_path, repo, substitution):
    from test_engine import FakeProvider

    from wiki_rag.engine import run
    from wiki_rag.state import read_manifest

    tracked(repo, "docs/a.md")
    git(repo, "commit", "-m", "first")
    cfg = load_config(config_file(tmp_path, repo))
    provider = FakeProvider()
    run(cfg, "index", apply=True, provider=provider)
    substitute_source(repo, tmp_path, substitution)
    run(cfg, "update", apply=True, provider=provider)
    assert read_manifest(cfg.state / "manifest.json")["collections"]["guide"]["files"] == {}


def test_remote_unselected_substitutions_and_committed_links_stay_excluded(tmp_path, repo):
    tracked(repo, "docs/a.md")
    tracked(repo, "private/a.md")
    tracked(repo, "not-selected.txt")
    (repo / "committed.md").symlink_to("docs/a.md")
    git(repo, "add", "committed.md")
    git(repo, "commit", "-m", "first")
    cfg = remote_config(tmp_path, repo)
    (repo / "private" / ".git").mkdir()
    (repo / "not-selected.txt").unlink()
    (repo / "not-selected.txt").symlink_to("docs/a.md")
    assert set(scan(cfg)["guide"].files) == {"docs/a.md"}


@pytest.mark.parametrize("substitution", ["file_symlink", "nested_directory"])
def test_remote_rescan_rejects_substitution_after_new_upload(
    tmp_path, repo, monkeypatch, substitution
):
    from test_engine import FakeProvider

    from wiki_rag.engine import run

    tracked(repo, "docs/a.md")
    tracked(repo, "b.md")
    git(repo, "commit", "-m", "first")
    cfg = remote_config(tmp_path, repo)
    authority, provider = Authority(cfg), FakeProvider()
    with backend(cfg, authority, monkeypatch) as remote:
        run(cfg, "index", apply=True, provider=provider, remote=remote)
    authority.complete(provider)
    before = json.loads(json.dumps(authority.manifest))
    tracked(repo, "b.md", "new committed bytes")
    git(repo, "commit", "-m", "update second file")
    upload = provider.upload

    def substitute_after_upload(*args):
        fid = upload(*args)
        substitute_source(repo, tmp_path, substitution)
        return fid

    provider.upload = substitute_after_upload
    with backend(cfg, authority, monkeypatch) as remote:
        with pytest.raises(RagError, match="selected committed source"):
            run(cfg, "index", apply=True, provider=provider, remote=remote)
    assert authority.manifest == before and provider.deleted == []
    assert provider.uploads == 3
