import json

import httpx
import pytest
from test_remote import remote_config

from wiki_rag.config import RagError
from wiki_rag.provider import OpenAIProvider
from wiki_rag.provider_diagnostics import error_details


def test_batch_failure_has_stage_size_attempt_timing_request_id_and_reason(
    tmp_path, repo, monkeypatch, capsys
):
    cfg = remote_config(tmp_path, repo)
    monkeypatch.setenv(cfg.api_key_env, "synthetic-secret-value")

    def handle(request):
        return httpx.Response(
            400,
            headers={"x-request-id": "req_test123"},
            json={
                "error": {
                    "type": "invalid_request_error",
                    "code": "invalid_value",
                    "param": "files[0].attributes.path",
                    "message": "Invalid 'attributes.path': string too long. "
                    "Maximum length is 512; got 'private-path'.",
                }
            },
        )

    with OpenAIProvider(cfg, transport=httpx.MockTransport(handle)) as provider:
        with pytest.raises(RagError) as error:
            provider.attach_batch(
                "vs_private",
                [{"file_id": "file-private", "attributes": {"path": "private-path"}}],
                cfg.processing["chunking"],
            )
    events = [
        json.loads(line.removeprefix("wiki-rag: ")) for line in capsys.readouterr().err.splitlines()
    ]
    assert events[0]["event"] == "provider_request_started" and events[0]["batch_size"] == 1
    event = events[-1]
    assert event["stage"] == "attach_batch" and event["status"] == 400 and event["attempt"] == 1
    assert event["request_id"] == "req_test123" and event["elapsed_ms"] >= 0
    assert event["param"] == "files[0].attributes.path"
    assert "Maximum length is 512" in event["reason"]
    assert "req_test123" in str(error.value)
    assert "private-path" not in str(events) and "synthetic-secret-value" not in str(events)


@pytest.mark.parametrize(
    "payload",
    [[], None, "failure", {"error": []}, {"error": {"type": {}, "code": [], "param": {}}}],
)
def test_malformed_error_diagnostics_do_not_hide_original_status(payload):
    assert isinstance(error_details(httpx.Response(400, json=payload)), dict)


def test_error_details_redact_sensitive_values_before_truncation():
    secret = "sensitive-" + "x" * 1500
    response = httpx.Response(
        400,
        json={
            "error": {
                "type": "file-private",
                "code": "file-private",
                "param": "attributes.private_customer_name",
                "message": f"Invalid 'quoted document excerpt'. {secret} PRIVATE_PATH "
                "file-private https://private.test/path a@private.test\nMaximum length is 512.",
            }
        },
    )
    result = error_details(response, sensitive=[secret, "PRIVATE_PATH"])
    assert set(result) == {"reason"}
    text = result["reason"]
    for private in (
        "quoted document excerpt",
        "sensitive",
        "PRIVATE_PATH",
        "file-private",
        "private.test",
        "\n",
    ):
        assert private not in text
    assert "Maximum length is 512" in text and len(text) <= 1000
