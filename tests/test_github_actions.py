import importlib
import json
import os
import subprocess
from pathlib import Path

import pytest
from conftest import git, tracked

from wiki_rag import RagError
from wiki_rag.engine import empty_manifest, guard_commits
from wiki_rag.selection import scan


def gha():
    assert importlib.util.find_spec("wiki_rag.github_actions"), "GitHub runner is missing"
    return importlib.import_module("wiki_rag.github_actions")


def configuration(repo, count=1):
    text = """version = 1
[remote_state]
workspace = "team-docs"
origin_env = "CUSTOM_ORIGIN"
client_id_env = "CUSTOM_ID"
client_secret_env = "CUSTOM_SECRET"
[openai]
project_id = "proj_example"
api_key_env = "CUSTOM_KEY"
"""
    for n in range(count):
        text += f"""
[[collections]]
name = "docs{n}"
repository = "example/source{n}"
root = "unused{n}"
branch = "main"
vector_store_id = "vs_example{n}"
include = ["**/*.md"]
extensions = [".md"]
"""
    path = tracked(repo, "wiki-rag.toml", text)
    git(repo, "commit", "-m", "Add config")
    return path


def workflow_parameters(count=1):
    return {
        "workspace": "team-docs",
        "project-id": "proj_example",
        "collections": json.dumps(
            [
                {
                    "name": f"docs{n}",
                    "repository": f"example/source{n}",
                    "branch": "main",
                    "vector_store_id": f"vs_example{n}",
                    "include": ["**/*.md"],
                    "extensions": [".md"],
                }
                for n in range(count)
            ]
        ),
        "max-files": 3,
        "max-file-bytes": 500_000,
        "max-total-bytes": 1_000_000,
        "chunk-size": 800,
        "chunk-overlap": 400,
    }


@pytest.fixture
def credentials(monkeypatch):
    values = {
        "WIKI_RAG_GATE_ORIGIN": "https://gate.example",
        "WIKI_RAG_ACCESS_CLIENT_ID": "synthetic-id",
        "WIKI_RAG_ACCESS_CLIENT_SECRET": "synthetic-gate-value",
        "WIKI_RAG_INGEST_KEY": "synthetic-provider-value",
        "WIKI_RAG_CHECKOUT_TOKEN": "synthetic-github-value",
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    return values


class Client:
    def __init__(self, cfg):
        self.cfg = cfg
        self.closed = False
        self.suppressed = None
        self.committed_publication = None
        self.fail = False

    def close(self):
        self.closed = True

    def finish(self, *, suppress=False):
        self.suppressed = suppress
        self.close()
        if self.fail and not suppress:
            raise RagError("lease release failed")


def factories(clients):
    def remote(cfg):
        assert os.environ[cfg.remote_state.client_secret_env] == "synthetic-gate-value"
        obj = Client(cfg)
        clients.append(obj)
        return obj

    def provider(cfg):
        assert os.environ[cfg.api_key_env] == "synthetic-provider-value"
        obj = Client(cfg)
        clients.append(obj)
        return obj

    return remote, provider


def source_repo(tmp_path):
    root = tmp_path / "source"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "config", "user.name", "Test")
    git(root, "config", "user.email", "test@example.org")
    tracked(root, "nested/readme.md", "literal $Id$\n")
    git(root, "commit", "-m", "Add content before attributes")
    tracked(
        root,
        ".gitattributes",
        "*.md text eol=crlf ident filter=evil working-tree-encoding=UTF-16LE\n",
    )
    git(root, "commit", "-m", "Add transformations")
    return root


def test_real_checkout_and_engine_git_are_literal_and_credential_scoped(
    repo, tmp_path, credentials, monkeypatch
):
    configuration(repo)
    source = source_repo(tmp_path)
    marker = tmp_path / "executed"
    global_config = tmp_path / "hostile.gitconfig"
    global_config.write_text(f'[filter "evil"]\n smudge = touch {marker}\n required = true\n')
    template = tmp_path / "hostile-template"
    (template / "hooks").mkdir(parents=True)
    hook = template / "hooks/post-checkout"
    hook.write_text(f"#!/bin/sh\ntouch '{marker}'\n")
    hook.chmod(0o755)
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(global_config))
    monkeypatch.setenv("GIT_TRACE", "1")
    monkeypatch.setenv("GIT_TEMPLATE_DIR", str(template))
    clients, observations = [], []
    remote, provider = factories(clients)
    original = subprocess.run

    def invoke(args, **kwargs):
        args = list(map(str, args))
        environment = dict(kwargs.get("env") or os.environ)
        observations.append((args, environment))
        assert "GIT_TRACE" not in environment
        for name in ("WIKI_RAG_ACCESS_CLIENT_SECRET", "WIKI_RAG_INGEST_KEY"):
            assert name not in environment
        assert not any(value in " ".join(args) for value in credentials.values())
        if "clone" in args:
            assert args[-2] == "https://github.com/example/source0.git"
            args[-2] = str(source)
            environment = dict(environment)
            count = int(environment.get("GIT_CONFIG_COUNT", 0))
            environment.update(
                {
                    "GIT_CONFIG_COUNT": str(count + 1),
                    f"GIT_CONFIG_KEY_{count}": "protocol.file.allow",
                    f"GIT_CONFIG_VALUE_{count}": "always",
                }
            )
            kwargs["env"] = environment
        return original(args, **kwargs)

    monkeypatch.setattr(subprocess, "run", invoke)
    roots = []

    def engine(cfg, command, **kwargs):
        assert command == "index" and kwargs["apply"] is True
        assert cfg.remote_state.workspace == "team-docs"
        assert cfg.collections[0].binding()["repository"] == "example/source0"
        snap = scan(cfg)
        assert snap["docs0"].files["nested/readme.md"].content == b"literal $Id$\n"
        prior = empty_manifest(cfg)
        prior["collections"] = {"docs0": {"repository_commit": snap["docs0"].commit}}
        guard_commits(cfg, snap, prior)
        roots.append(cfg.collections[0].root)
        stored = (roots[0] / ".git/config").read_text().lower()
        assert "synthetic" not in stored and "extraheader" not in stored
        assert "authorization" not in stored
        return {"publication_id": "00000000-0000-4000-8000-000000000001"}

    result = gha().execute(
        "wiki-rag.toml",
        workspace=repo,
        engine=engine,
        remote_factory=remote,
        provider_factory=provider,
    )
    assert result["workspace"] == "team-docs"
    assert clients and all(c.closed for c in clients)
    assert not roots[0].exists() and not marker.exists()
    assert any("merge-base" in args for args, _ in observations)
    for args, env in observations:
        headers = [
            v for k, v in env.items() if k.startswith("GIT_CONFIG_VALUE_") and "AUTHORIZATION" in v
        ]
        assert bool(headers) == ("clone" in args)
    assert os.environ["WIKI_RAG_INGEST_KEY"] == credentials["WIKI_RAG_INGEST_KEY"]


@pytest.mark.parametrize("change", ["dirty", "untracked", "symlink"])
def test_config_must_be_literal_tracked_file(repo, credentials, change):
    path = configuration(repo)
    if change == "dirty":
        path.write_text(path.read_text() + "\n# changed\n")
    elif change == "untracked":
        git(repo, "rm", "--cached", "wiki-rag.toml")
        git(repo, "commit", "-m", "Remove config")
    else:
        target = repo / "other.toml"
        path.rename(target)
        path.symlink_to(target)
    clients = []
    remote, provider = factories(clients)
    with pytest.raises(RagError):
        gha().execute(
            "wiki-rag.toml", workspace=repo, remote_factory=remote, provider_factory=provider
        )
    assert all(c.closed for c in clients)


@pytest.mark.parametrize("name", ["../wiki-rag.toml", "/tmp/wiki-rag.toml"])
def test_config_path_cannot_escape_workspace(repo, credentials, name):
    with pytest.raises(RagError):
        gha().execute(name, workspace=repo)


@pytest.mark.parametrize("bad", ["https://elsewhere/x", "../source", "owner/../x", "-owner/repo"])
def test_repository_identifiers_reject_urls_and_traversal(repo, credentials, bad):
    path = configuration(repo)
    path.write_text(path.read_text().replace("example/source0", bad))
    git(repo, "add", ".")
    git(repo, "commit", "-m", "Invalid repository")
    with pytest.raises(RagError):
        gha().execute("wiki-rag.toml", workspace=repo)


def test_second_checkout_failure_never_calls_engine_and_closes_clients(
    repo, credentials, monkeypatch
):
    configuration(repo, 2)
    clients, clones = [], []
    remote, provider = factories(clients)
    original = subprocess.run

    def invoke(args, **kwargs):
        if "clone" not in args:
            if "checkout" in args:
                return subprocess.CompletedProcess(args, 0, b"", b"")
            return original(args, **kwargs)
        clones.append(args)
        if len(clones) == 2:
            return subprocess.CompletedProcess(args, 1, b"", b"synthetic-github-value")
        (Path(args[-1]) / ".git/info").mkdir(parents=True)
        return subprocess.CompletedProcess(args, 0, b"", b"")

    monkeypatch.setattr(subprocess, "run", invoke)
    with pytest.raises(RagError, match="checkout") as error:
        gha().execute(
            "wiki-rag.toml",
            workspace=repo,
            remote_factory=remote,
            provider_factory=provider,
            engine=lambda *a, **kw: pytest.fail("partial run"),
        )
    assert "synthetic-github-value" not in str(error.value)
    assert len(clones) == 2 and all(c.closed for c in clients)


@pytest.mark.parametrize("direct_inputs", [False, True])
def test_plan_needs_no_openai_key_and_reuses_duplicate_source(
    repo, credentials, monkeypatch, direct_inputs
):
    params = None
    if direct_inputs:
        params = workflow_parameters(2)
        params["collections"] = params["collections"].replace("example/source1", "example/source0")
    else:
        path = configuration(repo, 2)
        path.write_text(path.read_text().replace("example/source1", "example/source0"))
        git(repo, "add", ".")
        git(repo, "commit", "-m", "Share source")
    monkeypatch.delenv("WIKI_RAG_INGEST_KEY")
    monkeypatch.delenv("WIKI_RAG_CHECKOUT_TOKEN")
    original = subprocess.run
    clones, clients = [], []
    remote, _ = factories(clients)

    def invoke(args, **kwargs):
        if "clone" in args:
            clones.append(args)
            (Path(args[-1]) / ".git/info").mkdir(parents=True)
            return subprocess.CompletedProcess(args, 0, b"", b"")
        if "checkout" in args:
            return subprocess.CompletedProcess(args, 0, b"", b"")
        return original(args, **kwargs)

    def engine(cfg, command, **kwargs):
        assert command == "plan" and kwargs.get("provider") is None
        assert cfg.collections[0].root == cfg.collections[1].root
        return {"mode": "preview"}

    monkeypatch.setattr(subprocess, "run", invoke)
    result = gha().execute(
        None if direct_inputs else "wiki-rag.toml",
        workspace=repo,
        workflow_inputs=params,
        mode="plan",
        remote_factory=remote,
        provider_factory=lambda _: pytest.fail("provider in plan"),
        engine=engine,
    )
    assert len(clones) == 1 and result["workspace"] == "team-docs"
    assert all(c.closed for c in clients)


@pytest.mark.parametrize("engine_failure", [False, True])
def test_release_failure_after_publication_stays_fatal(
    repo, credentials, monkeypatch, engine_failure
):
    configuration(repo)
    clients = []
    remote, provider = factories(clients)
    original = subprocess.run

    def invoke(args, **kwargs):
        if "clone" in args:
            (Path(args[-1]) / ".git/info").mkdir(parents=True)
            return subprocess.CompletedProcess(args, 0, b"", b"")
        if "checkout" in args:
            return subprocess.CompletedProcess(args, 0, b"", b"")
        return original(args, **kwargs)

    def engine(cfg, command, **kwargs):
        kwargs["remote"].fail = True
        if engine_failure:
            raise RagError("original engine error")
        return {"publication_id": "00000000-0000-4000-8000-000000000001"}

    monkeypatch.setattr(subprocess, "run", invoke)
    expected = "original engine error" if engine_failure else "publication committed.*00000000"
    with pytest.raises(RagError, match=expected):
        gha().execute(
            "wiki-rag.toml",
            workspace=repo,
            remote_factory=remote,
            provider_factory=provider,
            engine=engine,
        )
    assert all(c.closed for c in clients)
    assert clients[0].suppressed is engine_failure


def test_missing_key_rejected_before_clone(repo, credentials, monkeypatch):
    configuration(repo)
    monkeypatch.delenv("WIKI_RAG_INGEST_KEY")
    with pytest.raises(RagError, match="OpenAI"):
        gha().execute("wiki-rag.toml", workspace=repo)


@pytest.mark.parametrize(
    "mode,wait", [("delete", 300), ("sync", -1), ("sync", 1801), ("sync", 1.5)]
)
def test_invalid_operational_inputs(repo, credentials, mode, wait):
    with pytest.raises(RagError):
        gha().execute("wiki-rag.toml", workspace=repo, mode=mode, lease_wait_seconds=wait)


@pytest.mark.parametrize("branch", ["", "--upload-pack=bad", "bad name", "main\nother"])
def test_invalid_branch_never_runs_engine(repo, credentials, branch):
    path = configuration(repo)
    path.write_text(path.read_text().replace('branch = "main"', "branch = " + json.dumps(branch)))
    git(repo, "add", ".")
    git(repo, "commit", "-m", "Invalid branch")
    clients = []
    remote, provider = factories(clients)
    with pytest.raises(RagError):
        gha().execute(
            "wiki-rag.toml",
            workspace=repo,
            remote_factory=remote,
            provider_factory=provider,
            engine=lambda *a, **kw: pytest.fail("bad branch"),
        )
    assert all(c.closed for c in clients)


@pytest.mark.parametrize("direct_inputs", [False, True, "unlimited"])
def test_real_workflow_stdout_keeps_paths_private_through_index_noop_deletion(
    repo, tmp_path, credentials, monkeypatch, capsys, direct_inputs
):
    import httpx
    from test_engine import FakeProvider
    from test_remote import Authority

    from wiki_rag.remote_state import RemoteState

    if direct_inputs:
        params = workflow_parameters()
        if direct_inputs == "unlimited":
            params.update(
                {f"unlimited-{name}": True for name in ("files", "file-bytes", "total-bytes")}
            )
        monkeypatch.setenv("WIKI_RAG_WORKFLOW_INPUTS", json.dumps(params))
    else:
        configuration(repo)
    source = source_repo(tmp_path)
    excluded = ".run/SYNTHETIC_EXCLUDED_CASE/run.xml"
    tracked(source, excluded, "synthetic non-document fixture\n")
    git(source, "commit", "-m", "Add excluded synthetic fixture")
    original = subprocess.run

    def invoke(args, **kwargs):
        args = list(map(str, args))
        if "clone" in args:
            args[-2] = str(source)
            env = dict(kwargs["env"])
            count = int(env["GIT_CONFIG_COUNT"])
            env.update(
                {
                    "GIT_CONFIG_COUNT": str(count + 1),
                    f"GIT_CONFIG_KEY_{count}": "protocol.file.allow",
                    f"GIT_CONFIG_VALUE_{count}": "always",
                }
            )
            kwargs["env"] = env
        return original(args, **kwargs)

    monkeypatch.setattr(subprocess, "run", invoke)
    authority = None
    clients = []

    def remote(cfg):
        nonlocal authority
        authority = authority or Authority(cfg)
        obj = RemoteState(cfg, transport=httpx.MockTransport(authority.handle))
        clients.append(obj)
        return obj

    class Provider(FakeProvider):
        closes = 0

        def close(self):
            self.closes += 1

    provider = Provider()
    module = gha()
    execute = module.execute
    monkeypatch.setenv("GITHUB_WORKSPACE", str(repo))
    monkeypatch.setenv("GITHUB_OUTPUT", str(tmp_path / "workflow-output"))

    def prepared(config, **kwargs):
        return execute(
            config, **kwargs, remote_factory=remote, provider_factory=lambda cfg: provider
        )

    monkeypatch.setattr(module, "execute", prepared)

    def run(mode):
        argv = ["--mode", mode] + (["--workflow-inputs"] if direct_inputs else [])
        assert module.main(argv) == 0
        text = capsys.readouterr().out
        assert "SYNTHETIC_EXCLUDED_CASE" not in text
        assert excluded not in text and "nested/readme.md" not in text
        return json.loads(text)

    preview = run("plan")
    assert preview["collections"]["docs0"]["selected_files"] == 1
    assert preview["collections"]["docs0"]["skipped_files"] >= 1
    assert provider.uploads == 0
    first = run("sync")
    assert "nested/readme.md" in authority.manifest["collections"]["docs0"]["files"]
    second = run("sync")
    assert first["publication_id"] == second["publication_id"]
    assert provider.uploads == 1 and provider.closes == 2
    (source / "nested/readme.md").unlink()
    git(source, "add", "--", "nested/readme.md")
    git(source, "commit", "-m", "Remove selected synthetic document")
    deleted = run("sync")
    assert deleted["collections"]["docs0"]["changes"]["delete"] == 1
    assert authority.manifest["collections"]["docs0"]["files"] == {}
    assert provider.files == {} and "file-1" in provider.deleted
    assert provider.closes == 3
    assert all(c.client.is_closed for c in clients)
    assert not authority.held


def test_workflow_output_is_nonsecret_and_plan_publication_is_empty(tmp_path, monkeypatch, capsys):
    output = tmp_path / "output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.setattr(
        gha(), "execute", lambda *a, **kw: {"workspace": "team-docs", "mode": "preview"}
    )
    assert gha().main(["--mode", "plan"]) == 0
    assert output.read_text() == "workspace=team-docs\npublication-id=\n"
    assert json.loads(capsys.readouterr().out)["workspace"] == "team-docs"


def test_constructor_failure_closes_already_created_remote(repo, credentials):
    configuration(repo)
    clients = []
    remote, _ = factories(clients)

    def provider(cfg):
        raise RagError("cannot construct provider")

    with pytest.raises(RagError, match="cannot construct provider"):
        gha().execute(
            "wiki-rag.toml", workspace=repo, remote_factory=remote, provider_factory=provider
        )
    assert len(clients) == 1 and clients[0].closed


def test_local_authority_not_accepted(repo, credentials):
    path = configuration(repo)
    text = path.read_text()
    start, end = text.index("[remote_state]"), text.index("[openai]")
    path.write_text(text[:start] + 'state = ".state"\n' + text[end:])
    with pytest.raises(RagError, match="remote_state"):
        gha().execute("wiki-rag.toml", workspace=repo)


@pytest.mark.parametrize(
    "change",
    [
        {"workspace": "bad/workspace"},
        {"project-id": "other"},
        {"collections": "not-json"},
        {"collections": "[]"},
        {"collections": "{}"},
        {"max-files": True},
        {"max-file-bytes": -1},
        {"max-total-bytes": 200_000_001},
        {"chunk-overlap": 401},
        {"config": "wiki-rag.toml"},
        {"config-repository": "example/other"},
    ],
)
def test_direct_inputs_reject_invalid_config_before_client_creation(repo, credentials, change):
    params = workflow_parameters() | change
    with pytest.raises(RagError):
        gha().execute(
            None,
            workspace=repo,
            workflow_inputs=params,
            remote_factory=lambda _: pytest.fail("client before validation"),
        )


@pytest.mark.parametrize(
    "change",
    [
        {"repository": "https://elsewhere/source"},
        {"branch": "--upload-pack=bad"},
        {"branch": "bad name"},
        {"include": ["../secret"]},
        {"extensions": ["md"]},
        {"root": "/tmp"},
        {"vector_store_id": "invalid"},
    ],
)
def test_direct_inputs_preserve_collection_validation(repo, credentials, change):
    params = workflow_parameters()
    collection = json.loads(params["collections"])[0] | change
    params["collections"] = json.dumps([collection])
    with pytest.raises(RagError):
        gha().execute(None, workspace=repo, workflow_inputs=params)


def test_direct_inputs_reject_ambiguous_file_config(repo, credentials):
    configuration(repo)
    with pytest.raises(RagError, match="config"):
        gha().execute("wiki-rag.toml", workspace=repo, workflow_inputs=workflow_parameters())


def test_workflow_inputs_main_rejects_invalid_json_without_traceback(monkeypatch, capsys):
    monkeypatch.setenv("WIKI_RAG_WORKFLOW_INPUTS", "{")
    assert gha().main(["--workflow-inputs"]) == 2
    assert "Traceback" not in capsys.readouterr().err


@pytest.mark.parametrize(
    "ref,accepted", [("main", True), ("a" * 40, True), ("v1", False), ("../main", False)]
)
def test_real_workflow_revision_validator_accepts_only_main_or_sha(ref, accepted):
    import sys
    import textwrap

    workflow = Path(__file__).parents[1] / ".github/workflows/ingest.yml"
    script = workflow.read_text().split("python3 - <<'PY'\n", 1)[1].split("\n          PY", 1)[0]
    env = dict(
        os.environ,
        TOOL_REF=ref,
        MODE="plan",
        CONFIG_PATH="wiki-rag.toml",
        CONFIG_REPOSITORY="",
        CALLER_REPOSITORY="example/source0",
        CONFIG_REF="",
        LEASE_WAIT="300",
        WIKI_RAG_WORKFLOW_INPUTS=json.dumps(workflow_parameters()),
        EVENT_NAME="workflow_dispatch",
        RUN_REF="refs/heads/main",
        DEFAULT_BRANCH="main",
    )
    result = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(script)], env=env, capture_output=True, text=True
    )
    assert (result.returncode == 0) is accepted, result.stderr


@pytest.mark.parametrize(
    "event,ref,accepted",
    [
        ("workflow_dispatch", "refs/heads/feature/test", True),
        ("workflow_dispatch", "refs/heads/main", True),
        ("push", "refs/heads/main", True),
        ("push", "refs/heads/feature/test", False),
        ("pull_request", "refs/pull/1/merge", False),
        ("workflow_dispatch", "refs/tags/release", False),
    ],
)
def test_manual_dispatch_and_automatic_branch_boundaries(event, ref, accepted):
    import sys
    import textwrap

    workflow = Path(__file__).parents[1] / ".github/workflows/ingest.yml"
    script = workflow.read_text().split("python3 - <<'PY'\n", 1)[1].split("\n          PY", 1)[0]
    env = dict(
        os.environ,
        TOOL_REF="main",
        MODE="plan",
        CONFIG_PATH="wiki-rag.toml",
        CONFIG_REPOSITORY="",
        CALLER_REPOSITORY="example/source0",
        CONFIG_REF="",
        LEASE_WAIT="300",
        WIKI_RAG_WORKFLOW_INPUTS=json.dumps(workflow_parameters()),
        EVENT_NAME=event,
        RUN_REF=ref,
        DEFAULT_BRANCH="main",
    )
    result = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(script)], env=env, capture_output=True, text=True
    )
    assert (result.returncode == 0) is accepted, result.stderr
