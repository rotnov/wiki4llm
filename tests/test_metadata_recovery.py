"""Complete a known upload's empty attachment metadata without adopting foreign data."""

import copy
import json

import httpx
import pytest
from test_remote import remote_config

from wiki_rag.config import RagError
from wiki_rag.provider import OpenAIProvider
from wiki_rag.selection import digest


@pytest.fixture
def recovery(tmp_path, repo, monkeypatch):
    cfg = remote_config(tmp_path, repo)
    monkeypatch.setenv(cfg.api_key_env, "synthetic")
    content = b"Verified synthetic document\n"
    expected = {"repository": "example/source", "sha256": digest(content), "operation_id": "a" * 64}
    attachment = {
        "id": "file-owned",
        "vector_store_id": "vs_owned",
        "status": "completed",
        "attributes": {},
        "chunking_strategy": cfg.processing["chunking"],
    }
    file = {
        "id": "file-owned",
        "filename": "wiki-rag-owned.txt",
        "bytes": len(content),
        "purpose": "assistants",
    }
    calls, sleeps = [], []
    state = {
        "attachment": attachment,
        "file": file,
        "persist_update": True,
        "change_before_write": False,
        "post_status": 200,
    }

    def handle(request):
        calls.append((request.method, request.url.path))
        if request.method == "GET" and request.url.path == "/v1/files/file-owned":
            if state["change_before_write"]:
                attachment["attributes"] = {"foreign": "do-not-overwrite"}
            return httpx.Response(200, json=file)
        assert request.url.path == "/v1/vector_stores/vs_owned/files/file-owned"
        if request.method == "POST":
            assert json.loads(request.content) == {"attributes": expected}
            if state["persist_update"]:
                attachment["attributes"] = copy.deepcopy(expected)
            return httpx.Response(state["post_status"], json=attachment)
        return httpx.Response(200, json=attachment)

    with OpenAIProvider(
        cfg, transport=httpx.MockTransport(handle), sleep=sleeps.append
    ) as provider:

        def restore(**overrides):
            args = dict(
                filename=file["filename"],
                sha=digest(content),
                content=content,
                attributes=expected,
                chunking=cfg.processing["chunking"],
            )
            args.update(overrides)
            return provider.restore_owned_attributes("vs_owned", "file-owned", **args)

        yield state, expected, calls, restore, provider


def test_empty_metadata_restored_after_receipt_checks_and_read_back(recovery):
    state, expected, calls, restore, _ = recovery
    assert restore()["attributes"] == expected
    assert calls == [
        ("GET", "/v1/vector_stores/vs_owned/files/file-owned"),
        ("GET", "/v1/files/file-owned"),
        ("GET", "/v1/vector_stores/vs_owned/files/file-owned"),
        ("POST", "/v1/vector_stores/vs_owned/files/file-owned"),
        ("GET", "/v1/vector_stores/vs_owned/files/file-owned"),
    ]
    calls.clear()
    assert restore()["attributes"] == expected
    assert all(method == "GET" for method, _ in calls)


@pytest.mark.parametrize(
    "fault",
    [
        "content",
        "filename",
        "bytes",
        "purpose",
        "file_id",
        "attachment_id",
        "store",
        "chunking",
        "status",
        "attributes",
        "race",
        "guard",
    ],
)
def test_invalid_receipt_or_nonempty_metadata_never_written(recovery, fault):
    state, _, calls, restore, provider = recovery
    args = {}
    if fault == "content":
        args["content"] = b"wrong source"
    elif fault == "filename":
        args["filename"] = "other.txt"
    elif fault == "bytes":
        state["file"]["bytes"] += 1
    elif fault == "purpose":
        state["file"]["purpose"] = "fine-tune"
    elif fault == "file_id":
        state["file"]["id"] = "file-foreign"
    elif fault == "attachment_id":
        state["attachment"]["id"] = "file-foreign"
    elif fault == "store":
        state["attachment"]["vector_store_id"] = "vs_foreign"
    elif fault == "chunking":
        state["attachment"]["chunking_strategy"] = {"type": "other"}
    elif fault == "status":
        state["attachment"]["status"] = "failed"
    elif fault == "attributes":
        state["attachment"]["attributes"] = {"repository": "foreign"}
    elif fault == "race":
        state["change_before_write"] = True
    else:
        provider.mutation_guard = lambda: (_ for _ in ()).throw(RagError("lease lost"))
    with pytest.raises(RagError):
        restore(**args)
    assert all(method == "GET" for method, _ in calls)


def test_recovery_requires_persisted_readback(recovery):
    state, _, _, restore, _ = recovery
    state["persist_update"] = False
    with pytest.raises(RagError, match="readback"):
        restore()


def test_unknown_metadata_update_is_read_back_next_attempt_without_reposting(recovery):
    state, expected, calls, restore, _ = recovery
    state["post_status"] = 500
    with pytest.raises(RagError):
        restore()
    assert restore()["attributes"] == expected
    assert sum(method == "POST" for method, _ in calls) == 1


def test_engine_recovers_empty_attributes_without_new_upload_or_batch(tmp_path, repo, monkeypatch):
    from test_batch_remote import invoke, setup_batch

    cfg, authority, original = setup_batch(tmp_path, repo, 2)
    original.unknown_attach = True
    with pytest.raises(RagError):
        invoke(cfg, authority, original, monkeypatch)
    store = cfg.collections[0].vector_store_id
    for item in original.attachments.values():
        item["attributes"] = {}
        item["chunking_strategy"] = cfg.processing["chunking"]
    calls = []

    def handle(request):
        path = request.url.path
        calls.append((request.method, path))
        if path == f"/v1/vector_stores/{store}/files":
            return httpx.Response(
                200, json={"data": list(original.attachments.values()), "has_more": False}
            )
        fid = path.rsplit("/", 1)[-1]
        if path.startswith("/v1/files/"):
            assert request.method == "GET"
            return httpx.Response(
                200,
                json={
                    k: v
                    for k, v in dict(original.files[fid], purpose="assistants").items()
                    if k != "content"
                },
            )
        assert path == f"/v1/vector_stores/{store}/files/{fid}"
        item = original.attachments[store, fid]
        if request.method == "POST":
            item["attributes"] = json.loads(request.content)["attributes"]
        return httpx.Response(200, json=item)

    monkeypatch.setenv(cfg.api_key_env, "synthetic")
    with OpenAIProvider(cfg, transport=httpx.MockTransport(handle)) as provider:
        assert invoke(cfg, authority, provider, monkeypatch)["mode"] == "submitted"
    assert original.uploads == 2 and len(original.batches) == 1
    assert {op["phase"] for op in authority.ops.values()} == {"attached"}
    assert sum(method == "POST" for method, _ in calls) == 2


def test_batch_rate_retry_is_bounded_and_rechecks_lease(tmp_path, repo, monkeypatch):
    cfg = remote_config(tmp_path, repo)
    monkeypatch.setenv(cfg.api_key_env, "synthetic")
    calls, sleeps = [], []

    def handle(request):
        calls.append(request)
        return httpx.Response(429, headers={"Retry-After": "nonsense"})

    with OpenAIProvider(
        cfg, transport=httpx.MockTransport(handle), sleep=sleeps.append
    ) as provider:
        with pytest.raises(RagError):
            provider.attach_batch(
                "vs_owned",
                [{"file_id": "file-owned", "attributes": {}}],
                cfg.processing["chunking"],
            )
    assert len(calls) == 3 and sleeps == [60, 60]
    calls.clear()
    with OpenAIProvider(
        cfg, transport=httpx.MockTransport(handle), sleep=lambda _: None
    ) as provider:

        def guard():
            if calls:
                raise RagError("lease lost")

        provider.mutation_guard = guard
        with pytest.raises(RagError, match="lease lost"):
            provider.attach_batch(
                "vs_owned",
                [{"file_id": "file-owned", "attributes": {}}],
                cfg.processing["chunking"],
            )
    assert len(calls) == 1


def test_retry_known_rate_limit_but_never_unknown_create(tmp_path, repo, monkeypatch):
    cfg = remote_config(tmp_path, repo)
    monkeypatch.setenv(cfg.api_key_env, "synthetic")
    calls, sleeps = [], []

    def handle(request):
        calls.append(request)
        return (
            httpx.Response(429, headers={"Retry-After": "2"})
            if len(calls) == 1
            else httpx.Response(200, json={"id": "vsfb_test", "status": "in_progress"})
        )

    with OpenAIProvider(
        cfg, transport=httpx.MockTransport(handle), sleep=sleeps.append
    ) as provider:
        assert (
            provider.attach_batch(
                "vs_owned",
                [{"file_id": "file-owned", "attributes": {}}],
                cfg.processing["chunking"],
            )["id"]
            == "vsfb_test"
        )
    assert len(calls) == 2 and sleeps == [2]
    assert calls[0].content == calls[1].content
    calls.clear()

    def ambiguous(request):
        calls.append(request)
        return httpx.Response(500)

    with OpenAIProvider(
        cfg, transport=httpx.MockTransport(ambiguous), sleep=sleeps.append
    ) as provider:
        with pytest.raises(RagError):
            provider.attach_batch(
                "vs_owned",
                [{"file_id": "file-owned", "attributes": {}}],
                cfg.processing["chunking"],
            )
    assert len(calls) == 1
