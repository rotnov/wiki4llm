"""Ordinary sync captures all terminal evidence before bounded owned recovery."""

import copy
import json

import httpx
import pytest
from test_batch_remote import BatchProvider, invoke, setup_batch

from wiki_rag import RagError
from wiki_rag.provider import OpenAIProvider


class RecoveryProvider(BatchProvider):
    attachment_failures = OpenAIProvider.attachment_failures
    _diagnostic_secrets = ("provider-secret",)
    diagnostic_sensitive = ("gate-secret", "checkout-secret")

    def __init__(self):
        super().__init__()
        self.reads = []
        self.bad_page = False

    def upload(self, filename, content):
        fid = super().upload(filename, content)
        self.files[fid]["purpose"] = "assistants"
        return fid

    def attach_batch(self, store, items, chunking):
        result = super().attach_batch(store, items, chunking)
        for item in items:
            self.attachments[store, item["file_id"]]["chunking_strategy"] = chunking
        return result

    def request(self, method, path, **kwargs):
        assert method == "GET"
        self.reads.append(path)
        store = path.split("/")[1]
        data = [copy.deepcopy(item) for (s, _), item in self.attachments.items() if s == store]
        if self.bad_page and kwargs["params"].get("after"):
            return httpx.Response(200, json={"data": None, "has_more": False})
        return (
            httpx.Response(
                200,
                json={
                    "data": data[:100],
                    "has_more": self.bad_page or len(data) > 100,
                    "last_id": data[min(len(data), 100) - 1]["id"] if data else None,
                },
            )
            if not kwargs["params"].get("after")
            else httpx.Response(200, json={"data": data[100:], "has_more": False})
        )

    def json(self, method, path, **kwargs):
        assert method == "GET" and path.startswith("files/")
        self.reads.append(path)
        return copy.deepcopy(self.files.get(path.split("/")[1]))


def seeded(tmp_path, repo, monkeypatch, count=3):
    cfg, authority, _ = setup_batch(tmp_path, repo, count)
    provider = RecoveryProvider()
    invoke(cfg, authority, provider, monkeypatch)
    for index, op in enumerate(authority.ops.values()):
        item = provider.attachments[op["store"], op["file_id"]]
        item.update(
            status="failed",
            attributes={},
            usage_bytes=0,
            last_error={
                "code": "server_error",
                "message": "Internal failure gate-secret checkout-secret",
            },
        )
        if index == 0:
            op.update(phase="ingestion_failed", terminal_failure=True)
    authority.requests.clear()
    return cfg, authority, provider


def no_recovery_writes(authority, provider, uploads):
    assert provider.uploads == uploads and provider.deleted == []
    assert not [b for route, b in authority.requests if route == "checkpoint"]


def test_bulk_capture_and_all_markers_precede_first_delete(tmp_path, repo, monkeypatch, capsys):
    cfg, authority, provider = seeded(tmp_path, repo, monkeypatch)
    original_ids = {op["file_id"] for op in authority.ops.values()}
    delete = provider.delete_attachment

    def checked_delete(store, fid):
        text = capsys.readouterr().err if not provider.deleted else ""
        if not provider.deleted:
            for old in original_ids:
                assert f'"file_id": "{old}"' in text
            assert '"event": "terminal_diagnostic_scan_complete"' in text
            assert "gate-secret" not in text and "checkout-secret" not in text
            assert all(op.get("terminal_failure") for op in authority.ops.values())
            assert all(
                op["phase"] in {"ingestion_failed", "detach_pending"}
                for op in authority.ops.values()
            )
        delete(store, fid)

    provider.delete_attachment = checked_delete
    assert invoke(cfg, authority, provider, monkeypatch)["mode"] == "submitted"
    assert provider.uploads == 6
    assert original_ids.issubset(set(x for x in provider.deleted if isinstance(x, str)))
    live = [op for oid, op in authority.ops.items() if ".retired." not in oid]
    assert len(live) == 3 and all(op["ingestion_attempts"] == 2 for op in live)


@pytest.mark.parametrize(
    "change",
    [
        "completed",
        "in_progress",
        "missing",
        "conflict",
        "unknown",
        "invalid_file",
        "store",
        "file_id",
        "filename",
        "size",
        "purpose",
        "chunking",
        "hash",
        "budget",
    ],
)
def test_all_existing_failed_rows_require_fresh_proof(tmp_path, repo, monkeypatch, change):
    cfg, authority, provider = seeded(tmp_path, repo, monkeypatch)
    op = next(iter(authority.ops.values()))
    item = provider.attachments[op["store"], op["file_id"]]
    uploaded = provider.files[op["file_id"]]
    if change in {"completed", "in_progress"}:
        item["status"] = change
    elif change == "missing":
        del provider.attachments[op["store"], op["file_id"]]
    elif change == "conflict":
        item["attributes"] = {"sha256": "conflict"}
    elif change in {"unknown", "invalid_file"}:
        item["last_error"]["code"] = change
    elif change == "store":
        item["vector_store_id"] = "vs_other"
    elif change == "file_id":
        uploaded["id"] = "file-other"
    elif change in {"filename", "purpose"}:
        uploaded[change] = "other"
    elif change == "size":
        uploaded["bytes"] += 1
    elif change == "chunking":
        item["chunking_strategy"] = {"type": "other"}
    elif change == "hash":
        op["sha256"] = "f" * 64
    else:
        op["ingestion_attempts"] = 3
    with pytest.raises(RagError):
        invoke(cfg, authority, provider, monkeypatch)
    no_recovery_writes(authority, provider, 3)


def test_partial_capture_survives_bad_page_without_completion_or_mutation(
    tmp_path, repo, monkeypatch, capsys
):
    cfg, authority, provider = seeded(tmp_path, repo, monkeypatch)
    provider.bad_page = True
    with pytest.raises(RagError):
        invoke(cfg, authority, provider, monkeypatch)
    output = capsys.readouterr().err
    assert '"event": "terminal_diagnostic_failure"' in output
    assert '"event": "terminal_diagnostic_scan_complete"' not in output
    no_recovery_writes(authority, provider, 3)


def test_unknown_failure_is_logged_but_never_adopted(tmp_path, repo, monkeypatch, capsys):
    cfg, authority, provider = seeded(tmp_path, repo, monkeypatch)
    item = copy.deepcopy(next(iter(provider.attachments.values())))
    item.update(
        id="file-foreign", last_error={"code": "invalid_file", "message": "foreign failure"}
    )
    provider.attachments["vs_test", "file-foreign"] = item
    invoke(cfg, authority, provider, monkeypatch)
    assert '"file_id": "file-foreign"' in capsys.readouterr().err
    assert ("vs_test", "file-foreign") in provider.attachments
    assert "file-foreign" not in provider.deleted


def test_second_marker_batch_failure_has_no_deletes_and_resume_reproves(
    tmp_path, repo, monkeypatch
):
    cfg, authority, provider = seeded(tmp_path, repo, monkeypatch, 102)
    handle = authority.handle
    batches = []

    def reject_second(request):
        if request.url.path.endswith("/checkpoint"):
            body = json.loads(request.content)
            if body["upserts"] and all(
                x["operation"]["phase"] == "ingestion_failed" for x in body["upserts"]
            ):
                batches.append(body)
                if len(batches) == 2:
                    return httpx.Response(409, json={"error": "synthetic failure"})
        return handle(request)

    authority.handle = reject_second
    with pytest.raises(RagError):
        invoke(cfg, authority, provider, monkeypatch)
    assert len(batches) == 2 and all(len(b["upserts"]) <= 100 for b in batches)
    assert not provider.deleted and provider.uploads == 102
    marked = [op for op in authority.ops.values() if op["phase"] == "ingestion_failed"]
    assert len(marked) == 101
    authority.handle = handle
    authority.held = False  # Simulate expiry of the poisoned invocation's lease.
    provider.attachments[marked[1]["store"], marked[1]["file_id"]].update(status="completed")
    authority.requests.clear()
    with pytest.raises(RagError):
        invoke(cfg, authority, provider, monkeypatch)
    no_recovery_writes(authority, provider, 102)
    provider.attachments[marked[1]["store"], marked[1]["file_id"]]["status"] = "failed"
    assert invoke(cfg, authority, provider, monkeypatch)["mode"] == "submitted"
    assert provider.uploads == 204
    assert all(
        op["ingestion_attempts"] == 2 for oid, op in authority.ops.items() if ".retired." not in oid
    )


@pytest.mark.parametrize("phase", ["detach_pending", "detached", "file_delete_pending", "deleted"])
def test_interrupted_owned_retirement_resumes_without_terminal_readoption(
    tmp_path, repo, monkeypatch, phase
):
    cfg, authority, provider = seeded(tmp_path, repo, monkeypatch, 1)
    op = next(iter(authority.ops.values()))
    old_id = op["file_id"]
    op["phase"] = phase
    provider.attachments.clear()
    if phase == "deleted":
        provider.files.clear()
    assert invoke(cfg, authority, provider, monkeypatch)["mode"] == "submitted"
    assert provider.uploads == 2
    live = [v for k, v in authority.ops.items() if ".retired." not in k]
    assert live[0]["file_id"] != old_id and live[0]["ingestion_attempts"] == 2
    assert f"files/{old_id}" not in provider.reads


def test_attachment_changed_after_file_inspection_aborts(tmp_path, repo, monkeypatch):
    cfg, authority, provider = seeded(tmp_path, repo, monkeypatch)
    read = provider.json

    def change_after_read(method, path, **kwargs):
        result = read(method, path, **kwargs)
        next(iter(provider.attachments.values()))["status"] = "completed"
        return result

    provider.json = change_after_read
    with pytest.raises(RagError):
        invoke(cfg, authority, provider, monkeypatch)
    no_recovery_writes(authority, provider, 3)


def test_lease_loss_during_proof_prevents_all_recovery_writes(tmp_path, repo, monkeypatch):
    from test_remote import backend

    from wiki_rag.engine import run

    cfg, authority, provider = seeded(tmp_path, repo, monkeypatch)
    read = provider.json
    with backend(cfg, authority, monkeypatch) as remote:

        def lose_lease(method, path, **kwargs):
            result = read(method, path, **kwargs)
            remote.poison()
            return result

        provider.json = lose_lease
        with pytest.raises(RagError, match="lease"):
            run(cfg, "index", apply=True, provider=provider, remote=remote)
        # The expected poison is handled here, including final lease release.
        remote.finish(suppress=True)
        remote.epoch = None
    no_recovery_writes(authority, provider, 3)


def test_healthy_initial_noop_and_preview_never_scan(tmp_path, repo, monkeypatch):
    from test_remote import backend

    from wiki_rag.engine import run

    cfg, authority, _ = setup_batch(tmp_path, repo, 2)
    provider = RecoveryProvider()
    provider.attachment_failures = lambda *a, **k: pytest.fail("unexpected terminal scan")
    invoke(cfg, authority, provider, monkeypatch)
    authority.complete(provider)
    publication = authority.manifest["publication_id"]
    assert invoke(cfg, authority, provider, monkeypatch)["publication_id"] == publication
    with backend(cfg, authority, monkeypatch) as remote:
        assert run(cfg, "plan", provider=provider, remote=remote)["mode"] == "preview"
    assert provider.uploads == 2 and not provider.deleted


def test_healthy_selected_attachment_is_retained_during_bulk_recovery(tmp_path, repo, monkeypatch):
    cfg, authority, provider = seeded(tmp_path, repo, monkeypatch)
    op = list(authority.ops.values())[1]
    item = provider.attachments[op["store"], op["file_id"]]
    item["status"] = "in_progress"
    retained = op["file_id"]
    invoke(cfg, authority, provider, monkeypatch)
    assert retained in provider.files and retained not in provider.deleted
    assert provider.uploads == 5


def test_budget_failure_logs_candidate_after_full_scan(tmp_path, repo, monkeypatch, capsys):
    cfg, authority, provider = seeded(tmp_path, repo, monkeypatch)
    oid, op = next(iter(authority.ops.items()))
    op["ingestion_attempts"] = 3
    with pytest.raises(RagError, match="retry limit"):
        invoke(cfg, authority, provider, monkeypatch)
    output = capsys.readouterr().err
    assert '"event": "terminal_diagnostic_scan_complete"' in output
    assert '"event": "terminal_recovery_candidate"' in output
    assert f'"operation_id": "{oid}"' in output
    assert '"ingestion_attempts": 3' in output and '"source_bytes": 12' in output
    no_recovery_writes(authority, provider, 3)


@pytest.mark.parametrize("change", ["conflict", "unknown", "chunking", "identity", "bytes"])
def test_newly_discovered_attached_failure_requires_same_proof(tmp_path, repo, monkeypatch, change):
    cfg, authority, provider = seeded(tmp_path, repo, monkeypatch)
    op = list(authority.ops.values())[1]
    assert op["phase"] == "attached"
    item = provider.attachments[op["store"], op["file_id"]]
    if change == "conflict":
        item["attributes"] = {"sha256": "wrong"}
    elif change == "unknown":
        item["last_error"]["code"] = "unsupported_file"
    elif change == "chunking":
        item["chunking_strategy"] = {"type": "other"}
    elif change == "identity":
        item["vector_store_id"] = "vs_other"
    else:
        provider.files[op["file_id"]]["bytes"] += 1
    with pytest.raises(RagError):
        invoke(cfg, authority, provider, monkeypatch)
    no_recovery_writes(authority, provider, 3)


@pytest.mark.parametrize("attrs", [None, "absent", "exact"])
def test_valid_metadata_shapes_recover_with_full_file_proof(tmp_path, repo, monkeypatch, attrs):
    from wiki_rag.remote_batch import attributes
    from wiki_rag.selection import scan

    cfg, authority, provider = seeded(tmp_path, repo, monkeypatch, 1)
    oid, op = next(iter(authority.ops.items()))
    item = provider.attachments[op["store"], op["file_id"]]
    if attrs == "absent":
        item.pop("attributes")
    elif attrs == "exact":
        collection = cfg.collections[0]
        file = scan(cfg)[collection.name].files[op["path"]]
        item["attributes"] = attributes(collection, file, oid, op)
    else:
        item["attributes"] = attrs
    old_id = op["file_id"]
    invoke(cfg, authority, provider, monkeypatch)
    assert f"files/{old_id}" in provider.reads and old_id in provider.deleted


def test_later_store_failure_preserves_partial_logs_and_blocks_all_writes(
    tmp_path, repo, monkeypatch, capsys
):
    from dataclasses import replace

    cfg, authority, provider = seeded(tmp_path, repo, monkeypatch)
    cfg = replace(
        cfg,
        collections=cfg.collections
        + (
            replace(
                cfg.collections[0],
                name="second",
                vector_store_id="vs_other",
                repository="example/second",
            ),
        ),
    )
    authority.cfg = cfg
    request = provider.request

    def fail_second(method, path, **kwargs):
        if "vs_other" in path:
            return httpx.Response(200, json={"data": None, "has_more": False})
        return request(method, path, **kwargs)

    provider.request = fail_second
    with pytest.raises(RagError, match="invalid provider diagnosis page"):
        invoke(cfg, authority, provider, monkeypatch)
    text = capsys.readouterr().err
    assert '"event": "terminal_diagnostic_failure"' in text
    assert '"event": "terminal_diagnostic_scan_complete"' not in text
    no_recovery_writes(authority, provider, 3)


def test_nonterminal_retirement_keeps_existing_semantics(tmp_path, repo, monkeypatch):
    cfg, authority, provider = seeded(tmp_path, repo, monkeypatch, 1)
    op = next(iter(authority.ops.values()))
    op.pop("terminal_failure")
    op["phase"] = "deleted"
    provider.files.clear()
    provider.attachments.clear()
    provider.attachment_failures = lambda *a, **k: pytest.fail("nonterminal scan")
    invoke(cfg, authority, provider, monkeypatch)
    assert provider.uploads == 2
    live = [op for oid, op in authority.ops.items() if ".retired." not in oid]
    assert live[0]["ingestion_attempts"] == 1
