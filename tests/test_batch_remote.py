"""Remote submission returns before provider indexing, with bounded durable work."""

import json
import threading

import httpx
import pytest
from conftest import git, tracked
from test_engine import FakeProvider
from test_remote import Authority, backend, remote_config

from wiki_rag import RagError
from wiki_rag.engine import run
from wiki_rag.provider import OpenAIProvider, RejectedWrite


class AsyncAuthority(Authority):
    def __init__(self, cfg):
        super().__init__(cfg)
        self.job = None
        self.pending = None

    def metadata(self):
        value = super().metadata()
        value["features"] = ["async-submit-v1"]
        if self.job:
            value["job"] = self.job
        return value

    def handle(self, request):
        if request.url.path.endswith("/submit"):
            body = json.loads(request.content)
            self.requests.append(("submit", body))
            assert body["expected_revision"] == self.revision
            assert body["epoch"] == self.epoch
            self.pending = json.loads(body["manifestText"])
            self.revision += 1
            self.job = {
                "id": self.pending["publication_id"],
                "status": "pending",
                "total": sum(len(c["files"]) for c in self.pending["collections"].values()),
                "completed": 0,
            }
            return httpx.Response(200, json={"revision": self.revision, "job_id": self.job["id"]})
        return super().handle(request)

    def complete(self, provider):
        """Explicitly simulate a later server alarm; the CLI never calls this."""
        assert self.pending is not None
        for collection in self.pending["collections"].values():
            for item in collection["files"].values():
                op = self.ops[item["operation_id"]]
                assert op["phase"] in {"attached", "complete"}
                attached = provider.attachments[op["store"], op["file_id"]]
                attached["status"] = "completed"
                assert attached["attributes"]["operation_id"] == item["operation_id"]
                op["phase"] = "complete"
        self.manifest = self.pending
        self.pending = None
        self.revision += 1
        self.job.update(
            status="complete",
            completed=self.job["total"],
            publication_id=self.manifest["publication_id"],
        )


class BatchProvider(FakeProvider):
    def __init__(self):
        super().__init__()
        self.batches = []
        self.lists = 0
        self.polls = 0

    def attach_batch(self, store, items, chunking):
        self.batches.append((store, items, chunking))
        for item in items:
            # Avoid the legacy helper's one-at-a-time failure simulation.
            unknown = self.unknown_attach
            self.unknown_attach = False
            super().attach(store, item["file_id"], item["attributes"], chunking)
            self.unknown_attach = unknown
            self.attachments[store, item["file_id"]]["status"] = "in_progress"
        if self.unknown_attach:
            self.unknown_attach = False
            raise RagError("unknown batch attachment outcome")
        return {"id": "vsfb_test", "status": "in_progress"}

    def attachments_by_id(self, store, ids):
        self.lists += 1
        return {
            fid: self.attachments[store, fid] for fid in ids if (store, fid) in self.attachments
        }

    def wait_completed(self, *args):
        self.polls += 1
        raise AssertionError("CI must not wait for provider indexing")


def setup_batch(tmp_path, repo, count=1):
    for n in range(count):
        tracked(repo, f"{n}.md", f"synthetic {n}\n")
    git(repo, "commit", "-m", "Synthetic corpus")
    cfg = remote_config(tmp_path, repo)
    return cfg, AsyncAuthority(cfg), BatchProvider()


def test_terminal_recovery_logs_source_size_and_keeps_attempt_bound(
    tmp_path, repo, monkeypatch, capsys
):
    cfg, authority, provider = setup_batch(tmp_path, repo)
    invoke(cfg, authority, provider, monkeypatch)
    oid, op = next(iter(authority.ops.items()))
    op.update(phase="ingestion_failed", terminal_failure=True, ingestion_attempts=3)
    with pytest.raises(RagError, match="retry limit"):
        invoke(cfg, authority, provider, monkeypatch)
    text = capsys.readouterr().err
    assert '"event": "terminal_recovery_candidate"' in text
    assert f'"operation_id": "{oid}"' in text
    assert '"source_bytes":' in text
    assert '"ingestion_attempts": 3' in text
    assert provider.uploads == 1


def invoke(cfg, authority, provider, monkeypatch, command="index"):
    with backend(cfg, authority, monkeypatch) as remote:
        return run(cfg, command, apply=True, provider=provider, remote=remote)


def test_submit_returns_while_indexing_and_noop_after_server_completion(
    tmp_path, repo, monkeypatch
):
    cfg, authority, provider = setup_batch(tmp_path, repo, 3)
    result = invoke(cfg, authority, provider, monkeypatch)
    assert result["mode"] == "submitted" and result["job_id"]
    assert "publication_id" not in result
    assert authority.manifest is None and len(provider.batches) == 1
    assert provider.polls == provider.lists == 0
    assert {x["status"] for x in provider.attachments.values()} == {"in_progress"}
    authority.complete(provider)
    first = authority.manifest
    result = invoke(cfg, authority, provider, monkeypatch)
    assert result["mode"] == "applied" and result["publication_id"] == first["publication_id"]
    assert "job_id" not in result and provider.uploads == 3 and len(provider.batches) == 1


def test_concurrent_uploads_use_only_active_window_intents(tmp_path, repo, monkeypatch):
    cfg, authority, provider = setup_batch(tmp_path, repo, 16)
    original = provider.upload
    lock = threading.Lock()
    active = peak = 0
    ready = threading.Barrier(8, timeout=2)

    def upload(filename, content):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
            assert sum(o["phase"] == "upload_pending" for o in authority.ops.values()) <= 8
        ready.wait()
        with lock:
            value = original(filename, content)
            active -= 1
        return value

    provider.upload = upload
    invoke(cfg, authority, provider, monkeypatch)
    assert peak == 8 and provider.uploads == 16 and len(provider.batches) == 1
    counts = [len(b["upserts"]) for p, b in authority.requests if p == "checkpoint"]
    assert max(counts) > 1 and max(counts) <= 100
    assert all(
        len(b["ids"]) <= 50 for p, b in authority.requests if p == "operations" and "ids" in b
    )


def test_failed_upload_drains_workers_and_records_other_successes(tmp_path, repo, monkeypatch):
    cfg, authority, provider = setup_batch(tmp_path, repo, 12)
    original = provider.upload
    lock = threading.Lock()
    barrier = threading.Barrier(8, timeout=2)

    def upload(filename, content):
        barrier.wait()
        if content == b"synthetic 0\n":
            raise RejectedWrite("provider rejected upload")
        with lock:
            return original(filename, content)

    provider.upload = upload
    with pytest.raises(RejectedWrite):
        invoke(cfg, authority, provider, monkeypatch)
    phases = [o["phase"] for o in authority.ops.values()]
    assert phases.count("uploaded") == 7 and phases.count("upload_ready") == 1
    assert len(phases) == 8 and not provider.batches and authority.manifest is None


def test_uncertain_batch_reconciles_original_attributes_without_reposting(
    tmp_path, repo, monkeypatch
):
    cfg, authority, provider = setup_batch(tmp_path, repo, 2)
    provider.unknown_attach = True
    with pytest.raises(RagError, match="unknown"):
        invoke(cfg, authority, provider, monkeypatch)
    first_commit = git(repo, "rev-parse", "HEAD")
    tracked(repo, "not-selected.txt", "new source revision")
    git(repo, "commit", "-m", "Unselected change")
    result = invoke(cfg, authority, provider, monkeypatch)
    assert result["mode"] == "submitted" and len(provider.batches) == 1 and provider.uploads == 2
    assert provider.lists == 1
    assert {
        x["source_commit"] for x in authority.pending["collections"]["guide"]["files"].values()
    } == {first_commit}


def test_missing_uncertain_attachment_is_never_recreated(tmp_path, repo, monkeypatch):
    cfg, authority, provider = setup_batch(tmp_path, repo)
    provider.unknown_attach = True
    with pytest.raises(RagError):
        invoke(cfg, authority, provider, monkeypatch)
    provider.attachments.clear()
    with pytest.raises(RagError, match="0/1 found; 0 empty attribute records; missing attachment"):
        invoke(cfg, authority, provider, monkeypatch)
    assert len(provider.batches) == 1


@pytest.mark.parametrize(
    "field", ["id", "vector_store_id", "attributes", "status", "extra_attributes"]
)
def test_uncertain_attachment_diagnostics_identify_boundary_without_values(
    tmp_path, repo, monkeypatch, field
):
    cfg, authority, provider = setup_batch(tmp_path, repo)
    provider.unknown_attach = True
    with pytest.raises(RagError):
        invoke(cfg, authority, provider, monkeypatch)
    item = next(iter(provider.attachments.values()))
    if field == "extra_attributes":
        item["attributes"]["private"] = "value"
    else:
        item[field] = {"private": "value"} if field == "attributes" else "private-value"
    with pytest.raises(RagError) as raised:
        invoke(cfg, authority, provider, monkeypatch)
    message = str(raised.value)
    assert "1/1 found" in message
    if field == "extra_attributes":
        assert "attributes.keys mismatch" in message
    else:
        assert field in message
    if field == "attributes":
        assert "missing" in message and "0 empty attribute records" in message
    assert "private" not in message and "0.md" not in message and "file-" not in message
    assert len(provider.batches) == 1 and provider.uploads == 1


def test_uncertain_empty_metadata_reports_aggregate_count(tmp_path, repo, monkeypatch):
    cfg, authority, provider = setup_batch(tmp_path, repo, 2)
    provider.unknown_attach = True
    with pytest.raises(RagError):
        invoke(cfg, authority, provider, monkeypatch)
    for item in provider.attachments.values():
        item["attributes"] = {}
    with pytest.raises(
        RagError, match="2/2 found; 2 empty attribute records; attributes.repository missing"
    ):
        invoke(cfg, authority, provider, monkeypatch)
    assert len(provider.batches) == 1 and provider.uploads == 2
    assert {op["phase"] for op in authority.ops.values()} == {"attach_pending"}


def test_batch_provider_request_metadata_and_paginated_reconciliation(tmp_path, repo, monkeypatch):
    cfg, _, _ = setup_batch(tmp_path, repo)
    monkeypatch.setenv(cfg.api_key_env, "synthetic")
    calls = []
    items = [
        {"file_id": f"file-{i}", "attributes": {"operation_id": str(i), "commit": "c" * 40}}
        for i in range(2)
    ]
    chunking = cfg.processing["chunking"]

    def handle(request):
        calls.append(request)
        if request.method == "POST":
            assert request.url.path.endswith("/file_batches")
            assert json.loads(request.content) == {
                "files": [dict(i, chunking_strategy=chunking) for i in items]
            }
            return httpx.Response(200, json={"id": "vsfb_test", "status": "in_progress"})
        second = "after" in request.url.params
        i = 1 if second else 0
        return httpx.Response(
            200,
            json={
                "data": [
                    {
                        "id": f"file-{i}",
                        "attributes": items[i]["attributes"],
                        "status": "in_progress",
                    }
                ],
                "has_more": not second,
                "last_id": f"file-{i}",
            },
        )

    with OpenAIProvider(cfg, transport=httpx.MockTransport(handle)) as provider:
        assert provider.attach_batch("vs_test", items, chunking)["id"] == "vsfb_test"
        assert set(provider.attachments_by_id("vs_test", {"file-0", "file-1"})) == {
            "file-0",
            "file-1",
        }
    assert len(calls) == 3


@pytest.mark.parametrize(
    "response",
    [
        {"data": [1], "has_more": False},
        {"data": [], "has_more": True, "last_id": "file-x"},
        {"data": [], "has_more": "false"},
    ],
)
def test_batch_provider_rejects_malformed_reconciliation(tmp_path, repo, monkeypatch, response):
    cfg, _, _ = setup_batch(tmp_path, repo)
    monkeypatch.setenv(cfg.api_key_env, "synthetic")
    with OpenAIProvider(
        cfg, transport=httpx.MockTransport(lambda _: httpx.Response(200, json=response))
    ) as provider:
        with pytest.raises(RagError):
            provider.attachments_by_id("vs_test", {"file-0"})


def test_old_gate_fails_before_provider_writes(tmp_path, repo, monkeypatch):
    cfg, authority, provider = setup_batch(tmp_path, repo)
    metadata = authority.metadata

    def old_metadata():
        value = metadata()
        value.pop("features")
        return value

    authority.metadata = old_metadata
    with pytest.raises(RagError, match="async-submit-v1"):
        invoke(cfg, authority, provider, monkeypatch)
    assert provider.uploads == 0 and not authority.initialized and not authority.ops


def test_bulk_lookup_checkpoint_and_attachment_limits(tmp_path, repo, monkeypatch):
    import wiki_rag.remote_batch as batch

    cfg, authority, provider = setup_batch(tmp_path, repo, 130)
    monkeypatch.setattr(batch, "ATTACH_BATCH", 60)
    result = invoke(cfg, authority, provider, monkeypatch)
    assert result["mode"] == "submitted"
    lookups = [b for p, b in authority.requests if p == "operations" and "ids" in b]
    assert [len(b["ids"]) for b in lookups] == [50, 50, 30]
    checkpoints = [b for p, b in authority.requests if p == "checkpoint"]
    assert max(len(b["upserts"]) for b in checkpoints) <= 100
    assert len(checkpoints) < 80
    assert [len(items) for _, items, _ in provider.batches] == [60, 60, 10]


def test_default_attachment_batches_bound_provider_work_without_waiting(
    tmp_path, repo, monkeypatch
):
    cfg, authority, provider = setup_batch(tmp_path, repo, 501)
    result = invoke(cfg, authority, provider, monkeypatch)
    assert result["mode"] == "submitted"
    assert [len(items) for _, items, _ in provider.batches] == [500, 1]
    assert provider.uploads == 501 and provider.polls == 0
    assert all(op["phase"] == "attached" for op in authority.ops.values())


def test_poison_drains_active_uploads_without_further_journal_writes(tmp_path, repo, monkeypatch):
    cfg, authority, provider = setup_batch(tmp_path, repo, 12)
    original = provider.upload
    barrier = threading.Barrier(8, timeout=2)
    lock = threading.Lock()
    held = []

    def upload(filename, content):
        barrier.wait()
        with lock:
            value = original(filename, content)
            held[0].poison()
            return value

    provider.upload = upload
    with pytest.raises(RagError, match="lease"), backend(cfg, authority, monkeypatch) as remote:
        held.append(remote)
        run(cfg, "index", apply=True, provider=provider, remote=remote)
    assert provider.uploads == 8 and len(authority.ops) == 8
    assert {op["phase"] for op in authority.ops.values()} == {"upload_pending"}
    assert not provider.batches


def test_checkpoint_splits_byte_bound_before_count_bound(tmp_path, repo, monkeypatch):
    from wiki_rag.remote_state import SMALL_LIMIT, encode

    cfg, authority, _ = setup_batch(tmp_path, repo)
    with backend(cfg, authority, monkeypatch) as remote:
        remote.acquire()
        remote.load()
        remote.checkpoint_many(
            [
                {"id": f"{i:064x}", "operation": {"phase": "upload_ready", "padding": "x" * 8000}}
                for i in range(100)
            ]
        )
    requests = [b for p, b in authority.requests if p == "checkpoint"]
    assert len(requests) == 2 and sum(len(b["upserts"]) for b in requests) == 100
    assert all(len(encode(b)) <= SMALL_LIMIT for b in requests)


def test_provider_batch_bound_rejects_before_http(tmp_path, repo, monkeypatch):
    cfg, _, _ = setup_batch(tmp_path, repo)
    monkeypatch.setenv(cfg.api_key_env, "synthetic")
    with OpenAIProvider(
        cfg, transport=httpx.MockTransport(lambda _: pytest.fail("unexpected HTTP"))
    ) as provider:
        with pytest.raises(RagError, match="2000"):
            provider.attach_batch(
                "vs_test",
                [{"file_id": "file-a", "attributes": {}}] * 2001,
                cfg.processing["chunking"],
            )


def test_remote_status_summary_exposes_job_without_manifest(tmp_path, repo, monkeypatch, capsys):
    from wiki_rag import cli

    cfg, authority, provider = setup_batch(tmp_path, repo)
    submitted = invoke(cfg, authority, provider, monkeypatch)
    monkeypatch.setattr(cli, "load_config", lambda _: cfg)

    def status(*args, **kwargs):
        with backend(cfg, authority, monkeypatch) as remote:
            return run(cfg, "status", remote=remote)

    monkeypatch.setattr(cli, "run", status)
    assert cli.main(["status", "--summary"]) == 0
    output = json.loads(capsys.readouterr().out)
    assert output["job"]["id"] == submitted["job_id"] and output["job"]["status"] == "pending"
    assert "manifest" not in output and "0.md" not in json.dumps(output)


def test_rejected_attachment_batch_resumes_uploaded_receipts(tmp_path, repo, monkeypatch):
    cfg, authority, provider = setup_batch(tmp_path, repo, 3)
    attach = provider.attach_batch
    provider.attach_batch = lambda *args: (_ for _ in ()).throw(RejectedWrite("rejected batch"))
    with pytest.raises(RejectedWrite):
        invoke(cfg, authority, provider, monkeypatch)
    assert {o["phase"] for o in authority.ops.values()} == {"uploaded"}
    provider.attach_batch = attach
    assert invoke(cfg, authority, provider, monkeypatch)["mode"] == "submitted"
    assert provider.uploads == 3 and len(provider.batches) == 1


def test_unpublished_legacy_complete_receipts_are_retained(tmp_path, repo, monkeypatch):
    cfg, authority, provider = setup_batch(tmp_path, repo, 2)
    invoke(cfg, authority, provider, monkeypatch)
    authority.complete(provider)
    # Simulate serial-era complete journal receipts with no active publication.
    authority.manifest = None
    authority.job = None
    result = invoke(cfg, authority, provider, monkeypatch)
    assert result["mode"] == "submitted" and provider.uploads == 2
    assert len(provider.batches) == 1 and provider.deleted == []
    assert {o["phase"] for o in authority.ops.values()} == {"complete"}
