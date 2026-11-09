import json

import httpx
import pytest
from conftest import config_file, tracked

from wiki_rag import RagError, load_config
from wiki_rag.selection import digest


def provider_api():
    import wiki_rag

    assert hasattr(wiki_rag, "OpenAIProvider"), "fixed-origin HTTP adapter is not implemented"
    return wiki_rag.OpenAIProvider


def test_headers_upload_attachment_poll_and_no_secret_errors(tmp_path, repo, monkeypatch):
    cls = provider_api()
    cfg = load_config(config_file(tmp_path, repo))
    monkeypatch.setenv("TEST_INGEST_KEY", "synthetic-secret")
    monkeypatch.setenv("OPENAI_BASE_URL", "https://attacker.example")
    requests = []

    def handler(request):
        requests.append(request)
        assert str(request.url).startswith("https://api.openai.com/v1/")
        assert request.headers["OpenAI-Project"] == "proj_test"
        assert request.headers["Authorization"] == "Bearer synthetic-secret"
        if request.url.path == "/v1/files":
            assert b'name="purpose"' in request.content and b"assistants" in request.content
            return httpx.Response(200, json={"id": "file-1", "object": "file"})
        return httpx.Response(200, json={"id": "file-1", "status": "completed"})

    with cls(cfg, transport=httpx.MockTransport(handler), sleep=lambda _: None) as provider:
        assert provider.upload("unique.txt", b"text") == "file-1"
        provider.attach("vs_test", "file-1", {"path": "a.md"}, cfg.processing["chunking"])
        provider.wait_completed("vs_test", "file-1")
    assert len(requests) == 3
    payload = json.loads(requests[1].content)
    assert payload["file_id"] == "file-1" and payload["attributes"]["path"] == "a.md"


def test_read_retries_bounded_and_create_never_retries(tmp_path, repo, monkeypatch):
    cls = provider_api()
    cfg = load_config(config_file(tmp_path, repo))
    monkeypatch.setenv("TEST_INGEST_KEY", "synthetic-secret")
    count = 0

    def handler(request):
        nonlocal count
        count += 1
        return httpx.Response(503, text="synthetic-secret server body")

    with cls(cfg, transport=httpx.MockTransport(handler), sleep=lambda _: None) as provider:
        with pytest.raises(RagError) as err:
            provider.store_empty("vs_test")
        assert count == 3 and "synthetic-secret" not in str(err.value)
        count = 0
        with pytest.raises(RagError):
            provider.upload("x.txt", b"x")
        assert count == 1


def test_upload_reconciliation_paginates_and_verifies_content(tmp_path, repo, monkeypatch):
    cls = provider_api()
    cfg = load_config(config_file(tmp_path, repo))
    monkeypatch.setenv("TEST_INGEST_KEY", "synthetic-secret")

    def handler(request):
        if request.url.path.endswith("/content"):
            return httpx.Response(200, content=b"content")
        if request.url.params.get("after") == "file-old":
            return httpx.Response(
                200,
                json={"data": [{"id": "file-new", "filename": "unique.txt"}], "has_more": False},
            )
        return httpx.Response(
            200,
            json={
                "data": [{"id": "file-old", "filename": "other.txt"}],
                "last_id": "file-old",
                "has_more": True,
            },
        )

    with cls(cfg, transport=httpx.MockTransport(handler), sleep=lambda _: None) as provider:
        assert provider.reconcile_upload("unique.txt", digest(b"content")) == "file-new"
        with pytest.raises(RagError, match="unresolved"):
            provider.reconcile_upload("absent.txt", digest(b"content"))


def test_permission_rejection_and_redirect_do_not_expose_key(tmp_path, repo, monkeypatch):
    cls = provider_api()
    cfg = load_config(config_file(tmp_path, repo))
    monkeypatch.setenv("TEST_INGEST_KEY", "synthetic-secret")
    for status in [403, 302]:
        requests = []

        def handler(request):
            requests.append(request)
            return httpx.Response(
                status, text="synthetic-secret", headers={"Location": "https://attacker.example"}
            )

        with cls(cfg, transport=httpx.MockTransport(handler)) as provider:
            with pytest.raises(RagError) as err:
                provider.upload("unique.txt", b"x")
            assert "synthetic-secret" not in str(err.value)
            assert len(requests) == 1


def test_poll_requires_completed_and_is_bounded(tmp_path, repo, monkeypatch):
    cls = provider_api()
    cfg = load_config(config_file(tmp_path, repo))
    monkeypatch.setenv("TEST_INGEST_KEY", "synthetic-secret")
    for status in ["failed", "cancelled", "in_progress"]:
        count = 0

        def handler(request):
            nonlocal count
            count += 1
            return httpx.Response(200, json={"status": status})

        with cls(cfg, transport=httpx.MockTransport(handler), sleep=lambda _: None) as provider:
            with pytest.raises(RagError, match="ingestion"):
                provider.wait_completed("vs_test", "file-1")
        assert count <= 60


def test_cli_all_config_positions_and_apply_gate(tmp_path, repo, capsys, monkeypatch):
    import wiki_rag

    assert hasattr(wiki_rag, "main"), "CLI is not implemented"
    tracked(repo, "README.md")
    path = config_file(tmp_path, repo)
    monkeypatch.delenv("TEST_INGEST_KEY", raising=False)
    for argv in [
        ["--config", str(path), "plan"],
        ["index", "--config", str(path)],
        ["--config", str(path), "update"],
        ["status", "--config", str(path)],
    ]:
        assert wiki_rag.main(argv) == 0
        assert json.loads(capsys.readouterr().out)["network_requests"] == 0
    assert not (tmp_path / ".state").exists()


def test_native_pdf_upload_uses_pdf_filename_and_mime(tmp_path, repo, monkeypatch):
    cls = provider_api()
    cfg = load_config(config_file(tmp_path, repo))
    monkeypatch.setenv("TEST_INGEST_KEY", "synthetic-secret")
    seen = []

    def handler(request):
        seen.append(request.content)
        return httpx.Response(200, json={"id": "file-pdf"})

    data = b"%PDF-1.7\n\x00\n%%EOF\n"
    with cls(cfg, transport=httpx.MockTransport(handler)) as provider:
        provider.upload("unique.pdf", data)
    assert b"application/pdf" in seen[0]
    assert b'filename="unique.pdf"' in seen[0] and data in seen[0]


@pytest.mark.parametrize("status", ["failed", "cancelled"])
def test_terminal_ingestion_is_distinct_from_unknown_poll_failure(
    tmp_path, repo, monkeypatch, status
):
    cls = provider_api()
    cfg = load_config(config_file(tmp_path, repo))
    monkeypatch.setenv("TEST_INGEST_KEY", "synthetic-secret")

    def handler(request):
        return httpx.Response(
            200,
            json={
                "status": status,
                "last_error": {
                    "code": "server_error",
                    "message": "sensitive provider body must not escape",
                },
            },
        )

    with cls(cfg, transport=httpx.MockTransport(handler)) as provider:
        with pytest.raises(RagError) as error:
            provider.wait_completed("vs_test", "file-1")
        assert type(error.value).__name__ == "TerminalIngestionFailure"
        assert error.value.status == status
        assert "sensitive" not in str(error.value)
