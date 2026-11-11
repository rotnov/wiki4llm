"""CI diagnostics must not disclose document or excluded repository paths."""

import copy
import json

import pytest

from wiki_rag import cli, github_actions


def result(mode):
    return {
        "mode": mode,
        "workspace": "team-docs",
        "publication_id": "00000000-0000-4000-8000-000000000001",
        "network_requests": 2,
        "collections": {
            "docs": {
                "selected_files": 2,
                "selected_bytes": 42,
                "repository_commit": "a" * 40,
                "changes": [
                    {
                        "action": "add",
                        "path": "SYNTHETIC_SELECTED.md",
                        "reason": "new logical path",
                    },
                    {"action": "replace", "path": "SYNTHETIC_REPLACED.md", "reason": "changed"},
                    {"action": "delete", "path": "SYNTHETIC_REMOVED.md", "reason": "removed"},
                ],
                "skipped": [
                    {"path": "excluded/SYNTHETIC_CASE/scan.bin", "reason": "not included"},
                    {"path": "private/SYNTHETIC_OTHER.bin", "reason": "excluded"},
                ],
            }
        },
        "cleanup_pending": "SYNTHETIC_DIAGNOSTIC",
        "unresolved_operations": ["SYNTHETIC_UNRESOLVED"],
    }


@pytest.mark.parametrize("mode", ["plan", "sync"])
def test_github_stdout_contains_counts_without_paths(mode, monkeypatch, capsys, tmp_path):
    raw = result("preview" if mode == "plan" else "applied")
    before = copy.deepcopy(raw)
    monkeypatch.setattr(github_actions, "execute", lambda *a, **kw: raw)
    output = tmp_path / "output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    assert github_actions.main(["--mode", mode]) == 0
    text = capsys.readouterr().out
    assert "SYNTHETIC_" not in text
    summary = json.loads(text)
    assert summary["collections"]["docs"]["changes"] == {"add": 1, "replace": 1, "delete": 1}
    assert summary["collections"]["docs"]["skipped_files"] == 2
    assert summary["collections"]["docs"]["selected_files"] == 2
    assert summary["collections"]["docs"]["selected_bytes"] == 42
    assert summary["cleanup_pending"] is True
    assert summary["unresolved_operations"] == 1
    assert raw == before
    assert "SYNTHETIC_" not in output.read_text()
    assert "publication-id=00000000-0000-4000-8000-000000000001" in output.read_text()


@pytest.mark.parametrize("command", ["plan", "index", "update"])
def test_cli_summary_option_supports_prechecked_out_ci(command, monkeypatch, capsys):
    raw = result("preview")
    monkeypatch.setattr(cli, "load_config", lambda _: object())
    monkeypatch.setattr(cli, "run", lambda *a, **kw: raw)
    assert cli.main([command, "--summary"]) == 0
    text = capsys.readouterr().out
    assert "SYNTHETIC_" not in text
    assert json.loads(text)["collections"]["docs"]["skipped_files"] == 2


def test_local_cli_full_preview_remains_available(monkeypatch, capsys):
    raw = result("preview")
    monkeypatch.setattr(cli, "load_config", lambda _: object())
    monkeypatch.setattr(cli, "run", lambda *a, **kw: raw)
    assert cli.main(["plan"]) == 0
    assert json.loads(capsys.readouterr().out) == raw


def test_github_submission_outputs_pending_job_without_publication(monkeypatch, capsys, tmp_path):
    raw = result("submitted")
    job = raw.pop("publication_id")
    raw["job_id"] = job
    monkeypatch.setattr(github_actions, "execute", lambda *a, **kw: raw)
    output = tmp_path / "output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    assert github_actions.main(["--mode", "sync"]) == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["job_id"] == job and "publication_id" not in summary
    assert f"job-id={job}\nmode=submitted\n" in output.read_text()
    assert "publication-id=\n" in output.read_text()
