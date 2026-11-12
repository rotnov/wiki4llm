import json

import httpx
import pytest
from test_github_actions import configuration, gha, workflow_parameters
from test_github_actions import credentials as credentials

from wiki_rag.config import RagError
from wiki_rag.provider import OpenAIProvider


def record(fid="file-one", status="failed", **extra):
    return {
        "id": fid,
        "status": status,
        "attributes": {},
        "usage_bytes": 0,
        "last_error": {"code": "server_error", "message": "An internal error occurred."},
        **extra,
    }


@pytest.mark.parametrize("direct", [False, True])
def test_real_diagnose_entrypoint_scans_all_stores_without_gate_or_checkout(
    repo, credentials, monkeypatch, capsys, tmp_path, direct
):
    path = configuration(repo, 2)
    before = path.read_bytes()
    params = workflow_parameters(2)
    calls, clients = [], []

    def handle(request):
        calls.append(request)
        assert request.method == "GET"
        assert request.url.host == "api.openai.com"
        assert request.url.params["limit"] == "100"
        if "after" not in request.url.params:
            return httpx.Response(
                200,
                json={
                    "data": [record("file-complete", "completed"), record()],
                    "has_more": True,
                    "last_id": "file-one",
                },
            )
        assert request.url.params["after"] == "file-one"
        return httpx.Response(
            200,
            json={
                "data": [record("file-two", "cancelled", attributes=None)],
                "has_more": False,
            },
        )

    def provider(cfg):
        obj = OpenAIProvider(cfg, transport=httpx.MockTransport(handle))
        obj.mutation_guard = lambda: pytest.fail("provider mutation")
        clients.append(obj)
        return obj

    def forbidden(*args, **kwargs):
        pytest.fail("diagnosis must not construct gate, lease, submit, prepare or clone source")

    module = gha()
    execute = module.execute
    monkeypatch.setattr(module, "checkout", forbidden)
    monkeypatch.setattr(
        module,
        "execute",
        lambda config, **kw: execute(
            config,
            **kw,
            remote_factory=forbidden,
            engine=forbidden,
            provider_factory=provider,
        ),
    )
    monkeypatch.setenv("GITHUB_WORKSPACE", str(repo))
    monkeypatch.setenv("GITHUB_OUTPUT", str(tmp_path / "outputs"))
    monkeypatch.setenv("WIKI_RAG_WORKFLOW_INPUTS", json.dumps(params))
    assert module.main(["--mode", "diagnose"] + (["--workflow-inputs"] if direct else [])) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["mode"] == "diagnosed"
    assert result["provider_diagnostics"]["scanned_files"] == 6
    failures = result["provider_diagnostics"]["failures"]
    assert len(failures) == 4
    assert {f["collection"] for f in failures} == {"docs0", "docs1"}
    assert {f["file_id"] for f in failures} == {"file-one", "file-two"}
    assert {f["status"] for f in failures} == {"failed", "cancelled"}
    assert all(f["last_error"]["message"] == "An internal error occurred." for f in failures)
    assert all(
        f["last_error"]["code"] == "server_error" and f["usage_bytes"] == 0 for f in failures
    )
    assert {f["metadata_state"] for f in failures} == {"empty", "absent"}
    assert len(calls) == 4 and all(c.client.is_closed for c in clients)
    assert path.read_bytes() == before
    assert (tmp_path / "outputs").read_text().endswith("job-id=\nmode=diagnosed\n")


def test_scan_redacts_actual_message_and_never_serializes_other_fields(repo, credentials):
    cfg = gha().workflow_config(workflow_parameters(), repo)
    message = (
        "Provider could not parse file. synthetic-provider-value PRIVATE_PATH "
        "'private document excerpt' file-secret https://private.test a@private.test "
        "synthetic-gate-value\n" + "x" * 1500
    )

    def handle(request):
        return httpx.Response(
            200,
            json={
                "data": [
                    record(
                        attributes={"path": "PRIVATE_PATH"},
                        body="PRIVATE_BODY",
                        files=[],
                        last_error={
                            "code": "server_error",
                            "message": message,
                            "body": "PRIVATE_BODY",
                        },
                    )
                ],
                "has_more": False,
            },
        )

    with OpenAIProvider(cfg, transport=httpx.MockTransport(handle)) as provider:
        result = provider.attachment_failures("vs_test", sensitive=("synthetic-gate-value",))
    text = json.dumps(result)
    for private in (
        "PRIVATE_PATH",
        "PRIVATE_BODY",
        "private document excerpt",
        "file-secret",
        "private.test",
        "synthetic-gate-value",
        "synthetic-provider-value",
    ):
        assert private not in text
    failure = result["failures"][0]
    assert failure["file_id"] == "file-one"
    assert failure["last_error"]["message"].startswith("Provider could not parse file.")
    assert len(failure["last_error"]["message"]) <= 1000


@pytest.mark.parametrize(
    "page",
    [
        {"data": [], "has_more": True, "last_id": "file-one"},
        {"data": [record()], "has_more": "false"},
        {"data": [record(status="private-status")], "has_more": False},
        {"data": [record(fid="https://evil.test")], "has_more": False},
        {"data": [record(usage_bytes=True)], "has_more": False},
        {"data": [record(attributes=["private"])], "has_more": False},
        {"data": [record()] * 101, "has_more": False},
        {"data": [None], "has_more": False},
        {"data": [record()], "has_more": True, "last_id": "file-other"},
    ],
)
def test_scan_rejects_malformed_or_incomplete_pages(repo, credentials, page):
    cfg = gha().workflow_config(workflow_parameters(), repo)
    with OpenAIProvider(
        cfg, transport=httpx.MockTransport(lambda request: httpx.Response(200, json=page))
    ) as provider:
        with pytest.raises(RagError):
            provider.attachment_failures("vs_test")


def test_scan_rejects_repeated_cursor_and_oversized_response(repo, credentials):
    cfg = gha().workflow_config(workflow_parameters(), repo)
    for page in (
        {"data": [record()], "has_more": True, "last_id": "file-one"},
        {"data": [], "has_more": False, "body": "x" * 2_000_001},
    ):
        calls = []

        def handle(request):
            calls.append(request)
            return httpx.Response(200, json=page)

        with OpenAIProvider(cfg, transport=httpx.MockTransport(handle)) as provider:
            with pytest.raises(RagError):
                provider.attachment_failures("vs_test")
        assert len(calls) <= 2


def test_diagnose_rejects_dirty_config_before_provider(repo, credentials):
    path = configuration(repo)
    path.write_text(path.read_text() + "\n# changed\n")
    with pytest.raises(RagError, match="committed"):
        gha().execute(
            "wiki-rag.toml",
            workspace=repo,
            mode="diagnose",
            provider_factory=lambda _: pytest.fail("provider before config validation"),
        )


def test_scan_has_finite_page_budget(repo, credentials):
    cfg = gha().workflow_config(workflow_parameters(), repo)
    calls = []

    def handle(request):
        calls.append(request)
        fid = f"file-{len(calls)}"
        return httpx.Response(
            200,
            json={
                "data": [record(fid, "completed")],
                "has_more": True,
                "last_id": fid,
            },
        )

    with OpenAIProvider(cfg, transport=httpx.MockTransport(handle)) as provider:
        with pytest.raises(RagError, match="pagination limit"):
            provider.attachment_failures("vs_test")
    assert len(calls) == 1000


def test_diagnose_requires_key_before_provider(repo, credentials, monkeypatch):
    configuration(repo)
    monkeypatch.delenv("WIKI_RAG_INGEST_KEY")
    with pytest.raises(RagError, match="OpenAI"):
        gha().execute(
            "wiki-rag.toml",
            workspace=repo,
            mode="diagnose",
            provider_factory=lambda _: pytest.fail("provider without key"),
        )


def test_reusable_validator_accepts_diagnose():
    import os
    import subprocess
    import sys
    import textwrap
    from pathlib import Path

    workflow = (Path(__file__).parents[1] / ".github/workflows/ingest.yml").read_text()
    script = workflow.split("python3 - <<'PY'\n", 1)[1].split("\n          PY", 1)[0]
    result = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(script)],
        capture_output=True,
        env=dict(
            os.environ,
            TOOL_REF="main",
            MODE="diagnose",
            CONFIG_PATH="wiki-rag.toml",
            CONFIG_REPOSITORY="",
            CALLER_REPOSITORY="example/source0",
            CONFIG_REF="",
            LEASE_WAIT="300",
            WIKI_RAG_WORKFLOW_INPUTS=json.dumps(workflow_parameters()),
            EVENT_NAME="workflow_dispatch",
            RUN_REF="refs/heads/main",
            DEFAULT_BRANCH="main",
        ),
    )
    assert result.returncode == 0, result.stderr
