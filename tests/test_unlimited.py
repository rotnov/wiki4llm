"""Selection budgets are optional; source and publication boundaries are not."""

from dataclasses import replace

import pytest
from conftest import config_file, git, tracked
from test_github_actions import workflow_parameters
from test_remote import remote_config

from wiki_rag import RagError, load_config
from wiki_rag.cli import main
from wiki_rag.github_actions import workflow_config
from wiki_rag.remote_engine import prospective_bounds
from wiki_rag.selection import scan

FIELDS = {
    "max_files": (10000, 100000),
    "max_file_bytes": (2000000, 20000000),
    "max_total_bytes": (50000000, 200000000),
}


def unlimited_config(tmp_path, repo, remote=False):
    if remote:
        remote_config(tmp_path, repo)
        path = tmp_path / "wiki-rag.toml"
    else:
        path = config_file(tmp_path, repo)
    path.write_text(
        path.read_text().replace(
            "version = 1", "version = 1\n" + "\n".join(f'{key} = "unlimited"' for key in FIELDS)
        )
    )
    return load_config(path)


@pytest.mark.parametrize("field", FIELDS)
def test_explicit_unlimited_and_omitted_defaults(tmp_path, repo, field):
    cfg = load_config(config_file(tmp_path, repo))
    assert getattr(cfg, field) == FIELDS[field][0]
    cfg = load_config(config_file(tmp_path, repo, extra=f'{field} = "unlimited"'))
    assert getattr(cfg, field) is None
    for other in FIELDS.keys() - {field}:
        assert getattr(cfg, other) == FIELDS[other][0]


@pytest.mark.parametrize("field", FIELDS)
@pytest.mark.parametrize("value", ['"Unlimited"', '"0"', '""', "0", "-1", "true", "1.0"])
def test_unlimited_is_exact_and_not_an_invalid_number_alias(tmp_path, repo, field, value):
    with pytest.raises(RagError):
        load_config(config_file(tmp_path, repo, extra=f"{field} = {value}"))


@pytest.mark.parametrize("field", FIELDS)
def test_numeric_bounds_stay_unchanged(tmp_path, repo, field):
    maximum = FIELDS[field][1]
    assert (
        getattr(load_config(config_file(tmp_path, repo, extra=f"{field} = {maximum}")), field)
        == maximum
    )
    with pytest.raises(RagError):
        load_config(config_file(tmp_path, repo, extra=f"{field} = {maximum + 1}"))


@pytest.mark.parametrize("remote", [False, True])
def test_unlimited_reads_above_numeric_ceiling_and_preserves_filters(tmp_path, repo, remote):
    tracked(repo, "large.md", b"a" * 20_000_001)
    tracked(repo, ".env.md", "private")
    tracked(repo, "private/no.md", "excluded")
    tracked(repo, "key.md", "-----BEGIN " + "PRIVATE KEY-----")
    (repo / "link.md").symlink_to(repo / "large.md")
    git(repo, "add", "link.md")
    git(repo, "commit", "-m", "Synthetic sources")
    cfg = unlimited_config(tmp_path, repo, remote)
    snap = scan(cfg)["guide"]
    assert set(snap.files) == {"large.md"}
    assert len(snap.files["large.md"].content) == 20_000_001
    assert {item["reason"] for item in snap.skipped} >= {"secret", "excluded", "symlink"}
    for field, value in [("max_file_bytes", 20_000_000), ("max_total_bytes", 1), ("max_files", 1)]:
        if field == "max_files":
            tracked(repo, "second.md")
            git(repo, "commit", "-m", "Second source")
        with pytest.raises(RagError, match="limit"):
            scan(replace(cfg, **{field: value}))
    if remote:
        (repo / "large.md").write_text("dirty")
        with pytest.raises(RagError, match="literal"):
            scan(cfg)


def test_unlimited_cli_plan_uses_config_without_provider(tmp_path, repo, capsys):
    tracked(repo, "a.md")
    unlimited_config(tmp_path, repo)
    assert main(["--config", str(tmp_path / "wiki-rag.toml"), "plan"]) == 0
    assert '"network_requests": 0' in capsys.readouterr().out


def test_unlimited_local_count_does_not_remove_remote_protocol_cap(tmp_path, repo):
    for n in range(10001):
        (repo / f"{n}.md").write_text("x")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "Synthetic count boundary")
    local = unlimited_config(tmp_path, repo)
    snapshots = scan(local)
    assert len(snapshots["guide"].files) == 10001
    remote = unlimited_config(tmp_path, repo, True)
    with pytest.raises(RagError, match="remote.*10000.*protocol"):
        scan(remote)
    with pytest.raises(RagError, match="remote.*limit"):
        prospective_bounds(remote, snapshots)


@pytest.mark.parametrize("field", FIELDS)
def test_workflow_unlimited_switch_is_independent_and_numeric_compatible(tmp_path, field):
    params = workflow_parameters()
    switch = "unlimited-" + field.removeprefix("max_").replace("_", "-")
    params[switch] = True
    # Model the exact toJSON(inputs) transport used by the workflow.
    import json

    cfg = workflow_config(json.loads(json.dumps(params)), tmp_path)
    assert getattr(cfg, field) is None
    for other in FIELDS.keys() - {field}:
        assert getattr(cfg, other) == params[other.replace("_", "-")]
    params[switch] = False
    assert getattr(workflow_config(params, tmp_path), field) == params[field.replace("_", "-")]


@pytest.mark.parametrize("value", ["true", "false", 1, 0, None])
def test_workflow_unlimited_requires_real_boolean(tmp_path, value):
    params = workflow_parameters()
    params["unlimited-files"] = value
    with pytest.raises(RagError, match="boolean"):
        workflow_config(params, tmp_path)


def test_workflow_switch_does_not_hide_invalid_numeric_input(tmp_path):
    params = workflow_parameters()
    params.update({"unlimited-files": True, "max-files": -1})
    with pytest.raises(RagError, match="bounds"):
        workflow_config(params, tmp_path)


@pytest.mark.parametrize("unlimited", [True, False, "true", 1, None])
@pytest.mark.parametrize("direct", [True, False])
def test_workflow_validation_enforces_boolean_and_direct_only(unlimited, direct):
    import json
    import os
    import subprocess
    import sys
    import textwrap
    from pathlib import Path

    workflow = Path(__file__).parents[1] / ".github/workflows/ingest.yml"
    script = workflow.read_text().split("python3 - <<'PY'\n", 1)[1].split("\n          PY", 1)[0]
    params = workflow_parameters() if direct else {"config": "wiki-rag.toml"}
    params["unlimited-files"] = unlimited
    env = dict(
        os.environ,
        TOOL_REF="main",
        MODE="plan",
        CONFIG_PATH="wiki-rag.toml",
        CONFIG_REPOSITORY="",
        CALLER_REPOSITORY="example/source0",
        CONFIG_REF="",
        LEASE_WAIT="300",
        WIKI_RAG_WORKFLOW_INPUTS=json.dumps(params),
        EVENT_NAME="workflow_dispatch",
        RUN_REF="refs/heads/main",
        DEFAULT_BRANCH="main",
    )
    result = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(script)], env=env, capture_output=True, text=True
    )
    accepted = type(unlimited) is bool and (direct or not unlimited)
    assert (result.returncode == 0) is accepted, result.stderr


def test_safe_read_still_checks_bytes_when_file_grows_after_stat(tmp_path, repo, monkeypatch):
    import os
    from types import SimpleNamespace

    from wiki_rag.selection import safe_read

    tracked(repo, "a.md", "bigger than three bytes")
    real_stat = os.fstat
    monkeypatch.setattr(
        os, "fstat", lambda fd: SimpleNamespace(st_mode=real_stat(fd).st_mode, st_size=1)
    )
    with pytest.raises(RagError, match="size limit"):
        safe_read(repo, "a.md", 3)
    assert safe_read(repo, "a.md", None) == b"bigger than three bytes"


def test_unlimited_does_not_remove_remote_manifest_byte_budget(tmp_path, repo):
    from wiki_rag.selection import Snapshot, SourceFile

    cfg = unlimited_config(tmp_path, repo, True)
    files = {}
    for n in range(10000):
        path = "a/" * 200 + f"{n}.md"
        files[path] = SourceFile(path, b"x", "a" * 64, "b" * 64, "md", "c" * 40, "utf8-text-v1")
    with pytest.raises(RagError, match="manifest.*size budget"):
        prospective_bounds(cfg, {"guide": Snapshot(files, [], "c" * 40)})
