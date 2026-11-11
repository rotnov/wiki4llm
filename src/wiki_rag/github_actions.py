"""Reusable workflow runner: validated inputs, disposable sources, remote state only."""

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path

from .config import RagError, config_from_mapping, integer, keys, lexical_path, load_config
from .output import summarize
from .provider import OpenAIProvider
from .remote_engine import run_remote
from .remote_state import RemoteState

INPUT_ENV = {
    "WIKI_RAG_GATE_ORIGIN",
    "WIKI_RAG_ACCESS_CLIENT_ID",
    "WIKI_RAG_ACCESS_CLIENT_SECRET",
    "WIKI_RAG_INGEST_KEY",
    "WIKI_RAG_CHECKOUT_TOKEN",
    "WIKI_RAG_WORKFLOW_INPUTS",
}
GIT_SETTINGS = {
    "core.hooksPath": "/dev/null",
    "core.fsmonitor": "false",
    "core.autocrlf": "false",
    "core.eol": "lf",
    "credential.helper": "",
    "http.followRedirects": "false",
    "protocol.allow": "never",
    "protocol.https.allow": "always",
}


def secret(name, *, required=True):
    value = os.environ.get(name, "")
    if (required and not value) or any(ord(c) < 33 or ord(c) > 126 for c in value):
        label = "OpenAI key" if name == "WIKI_RAG_INGEST_KEY" else "workflow credential"
        raise RagError(f"missing or invalid {label}")
    return value


@contextmanager
def git_environment():
    """This standalone runner owns its process; clients already captured their headers."""
    previous = dict(os.environ)
    clean = {k: v for k, v in previous.items() if k not in INPUT_ENV and not k.startswith("GIT_")}
    clean.update(
        GIT_CONFIG_NOSYSTEM="1",
        GIT_CONFIG_GLOBAL="/dev/null",
        GIT_ATTR_NOSYSTEM="1",
        GIT_TERMINAL_PROMPT="0",
        GIT_CONFIG_COUNT=str(len(GIT_SETTINGS)),
    )
    for n, (key, value) in enumerate(GIT_SETTINGS.items()):
        clean[f"GIT_CONFIG_KEY_{n}"] = key
        clean[f"GIT_CONFIG_VALUE_{n}"] = value
    os.environ.clear()
    os.environ.update(clean)
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(previous)


def git(*args, env=None):
    try:
        result = subprocess.run(
            ["git", *map(str, args)],
            env=env,
            capture_output=True,
            timeout=180,
            check=False,
        )
    except OSError, subprocess.TimeoutExpired:
        raise RagError("Git checkout/inspection failed; verify source access and retry") from None
    if result.returncode:
        raise RagError(
            "Git checkout/inspection failed; other private repositories may require github-token"
        )
    return result.stdout


def committed_config(path, content):
    root = Path(git("-C", path.parent, "rev-parse", "--show-toplevel").decode().strip())
    relative = path.relative_to(root).as_posix()
    entry = git("-C", root, "ls-tree", "-z", "HEAD", "--", relative)
    if not entry.startswith((b"100644 blob ", b"100755 blob ")):
        raise RagError("workflow config must be a regular HEAD-tracked file")
    if git("-C", root, "cat-file", "blob", "HEAD:" + relative) != content:
        raise RagError("workflow config must match its literal committed bytes")


def checkout(repository, branch, destination, template, token):
    env = dict(os.environ)
    if token:
        n = int(env["GIT_CONFIG_COUNT"])
        encoded = base64.b64encode(("x-access-token:" + token).encode()).decode()
        env.update(
            {
                "GIT_CONFIG_COUNT": str(n + 1),
                f"GIT_CONFIG_KEY_{n}": "http.https://github.com/.extraheader",
                f"GIT_CONFIG_VALUE_{n}": "AUTHORIZATION: basic " + encoded,
            }
        )
    git(
        "clone",
        "--no-checkout",
        "--no-recurse-submodules",
        "--template=" + str(template),
        "--branch",
        branch,
        "--",
        f"https://github.com/{repository}.git",
        destination,
        env=env,
    )
    # info/attributes has precedence over repository attributes, including nested files.
    (destination / ".git/info").mkdir(exist_ok=True)
    (destination / ".git/info/attributes").write_text(
        "* -filter -ident -text -eol -working-tree-encoding\n"
    )
    git("-C", destination, "checkout", "--force", branch, "--")


def finish_clients(remote, provider, result, failed):
    error = None
    try:
        if remote is not None:
            remote.finish(suppress=failed)
    except Exception as exc:
        error = exc
    finally:
        try:
            if provider is not None:
                provider.close()
        except Exception as exc:
            error = error or exc
    if error is not None and not failed:
        publication = (result or {}).get("publication_id")
        prefix = f"publication committed ({publication}); " if publication else ""
        raise RagError(prefix + "lease/client cleanup failed; rerun with fresh source") from None


def workflow_config(inputs, workspace):
    """Build remote configuration from workflow_call inputs using the shared validators."""
    limits = {
        "max-files": 10000,
        "max-file-bytes": 2_000_000,
        "max-total-bytes": 50_000_000,
        "chunk-size": 800,
        "chunk-overlap": 400,
    }
    unlimited = {
        "unlimited-files": ("max_files", 100000),
        "unlimited-file-bytes": ("max_file_bytes", 20_000_000),
        "unlimited-total-bytes": ("max_total_bytes", 200_000_000),
    }
    keys(
        inputs,
        set(limits)
        | set(unlimited)
        | {
            "workspace",
            "project-id",
            "collections",
            "config",
            "config-repository",
            "config-ref",
            "tool-ref",
            "tool-repository",
            "gate-origin",
            "mode",
            "environment",
            "lease-wait-seconds",
        },
        {"workspace", "project-id", "collections"},
    )
    if any(inputs.get(k) for k in ("config", "config-repository", "config-ref")):
        raise RagError("choose workflow parameters or a committed config, not both")
    try:
        collections = json.loads(inputs["collections"])
    except TypeError, ValueError:
        raise RagError("collections must be a JSON array") from None
    if not isinstance(collections, list):
        raise RagError("collections must be a JSON array")
    for collection in collections:
        keys(
            collection,
            {"name", "repository", "vector_store_id", "branch", "include", "exclude", "extensions"},
        )
    raw = {
        "version": 1,
        "openai": {"project_id": inputs["project-id"], "api_key_env": "WIKI_RAG_INGEST_KEY"},
        "remote_state": {
            "workspace": inputs["workspace"],
            "origin_env": "WIKI_RAG_GATE_ORIGIN",
            "client_id_env": "WIKI_RAG_ACCESS_CLIENT_ID",
            "client_secret_env": "WIKI_RAG_ACCESS_CLIENT_SECRET",
        },
        "collections": [dict(c, root=".") for c in collections],
        **{key.replace("-", "_"): inputs.get(key, default) for key, default in limits.items()},
    }
    for switch, (field, maximum) in unlimited.items():
        enabled = inputs.get(switch, False)
        if type(enabled) is not bool:
            raise RagError(f"{switch} must be a boolean")
        # Keep the workflow's numeric input contract even when its budget is disabled.
        if type(raw[field]) is not int or raw[field] != -1:
            integer(raw[field], 1, maximum)
        if enabled:
            raw[field] = -1
    return config_from_mapping(raw, workspace / "workflow-inputs.toml")


def execute(
    config_path,
    *,
    workspace,
    workflow_inputs=None,
    mode="sync",
    lease_wait_seconds=300,
    engine=run_remote,
    remote_factory=RemoteState,
    provider_factory=OpenAIProvider,
):
    if mode not in {"sync", "plan"}:
        raise RagError("mode must be sync or plan")
    if type(lease_wait_seconds) is not int or not 0 <= lease_wait_seconds <= 1800:
        raise RagError("lease wait must be an integer from 0 to 1800")
    workspace = lexical_path(workspace)
    path = content = None
    if workflow_inputs is not None:
        if config_path is not None:
            raise RagError("choose workflow parameters or a committed config, not both")
        cfg = workflow_config(workflow_inputs, workspace)
    else:
        if config_path is None:
            raise RagError("config path required")
        relative = Path(config_path)
        if relative.is_absolute() or ".." in relative.parts or "\\" in str(relative):
            raise RagError("config must be a relative path inside the caller workspace")
        path = lexical_path(workspace / relative)
        if not path.is_relative_to(workspace) or not path.is_file():
            raise RagError("config must be a regular file inside the caller workspace")
        content = path.read_bytes()
        cfg = load_config(path)
    if cfg.remote_state is None:
        raise RagError("reusable ingestion requires remote_state")
    for c in cfg.collections:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", c.repository):
            raise RagError("collections require GitHub owner/repository identifiers")
        if not c.branch or c.branch.startswith("-"):
            raise RagError("collections require explicit branch names")
    cfg = replace(
        cfg,
        api_key_env="WIKI_RAG_INGEST_KEY",
        remote_state=replace(
            cfg.remote_state,
            origin_env="WIKI_RAG_GATE_ORIGIN",
            client_id_env="WIKI_RAG_ACCESS_CLIENT_ID",
            client_secret_env="WIKI_RAG_ACCESS_CLIENT_SECRET",
            lease_wait_seconds=lease_wait_seconds,
        ),
    )
    secret("WIKI_RAG_ACCESS_CLIENT_ID")
    secret("WIKI_RAG_ACCESS_CLIENT_SECRET")
    secret("WIKI_RAG_INGEST_KEY", required=mode == "sync")
    token = secret("WIKI_RAG_CHECKOUT_TOKEN", required=False)
    remote = provider = result = None
    try:
        remote = remote_factory(cfg)  # Capture only headers; constructor makes no requests.
        if mode == "sync":
            provider = provider_factory(cfg)
    except BaseException:
        finish_clients(remote, provider, None, True)
        raise
    with git_environment():
        try:
            if path is not None:
                committed_config(path, content)
                if path.read_bytes() != content:
                    raise RagError("workflow config changed during preparation")
            for c in cfg.collections:
                git("check-ref-format", "--branch", c.branch)
            with tempfile.TemporaryDirectory(prefix="wiki-rag-sources-") as directory:
                root = Path(directory).resolve()
                template = root / "template"
                template.mkdir()
                sources, collections = {}, []
                for c in cfg.collections:
                    key = (c.repository, c.branch)
                    if key not in sources:
                        target = root / str(len(sources))
                        checkout(c.repository, c.branch, target, template, token)
                        sources[key] = target
                    collections.append(replace(c, root=sources[key]))
                cfg = replace(cfg, collections=tuple(collections))
                result = engine(
                    cfg,
                    "index" if mode == "sync" else "plan",
                    apply=mode == "sync",
                    provider=provider,
                    remote=remote,
                )
                result = {**result, "workspace": cfg.remote_state.workspace}
        finally:
            finish_clients(remote, provider, result, sys.exc_info()[0] is not None)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    config_args = parser.add_mutually_exclusive_group()
    config_args.add_argument("--config")
    config_args.add_argument("--workflow-inputs", action="store_true")
    parser.add_argument("--mode", default="sync", choices=("sync", "plan"))
    parser.add_argument("--lease-wait-seconds", type=int, default=300)
    args = parser.parse_args(argv)
    try:
        inputs = None
        if args.workflow_inputs:
            try:
                inputs = json.loads(os.environ.get("WIKI_RAG_WORKFLOW_INPUTS", ""))
            except ValueError:
                raise RagError("workflow inputs must be valid JSON") from None
            if not isinstance(inputs, dict):
                raise RagError("workflow inputs must be an object")
        result = execute(
            None if args.workflow_inputs else (args.config or "wiki-rag.toml"),
            workflow_inputs=inputs,
            workspace=os.environ.get("GITHUB_WORKSPACE", os.getcwd()),
            mode=args.mode,
            lease_wait_seconds=args.lease_wait_seconds,
        )
        publication = result.get("publication_id", "")
        if publication and not re.fullmatch(r"[0-9a-f-]{36}", publication):
            raise RagError("invalid publication output")
        if os.environ.get("GITHUB_OUTPUT"):
            with Path(os.environ["GITHUB_OUTPUT"]).open("a") as stream:
                stream.write(f"workspace={result['workspace']}\npublication-id={publication}\n")
        print(json.dumps(summarize(result), indent=2))
        return 0
    except RagError as exc:
        print(f"wiki-rag: {exc}", file=sys.stderr)
        return 2
    except OSError, ValueError:
        print("wiki-rag: workflow preparation or output failed", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("wiki-rag: interrupted; rerun to reconcile remote state", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
