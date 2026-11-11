import dataclasses
import hashlib
import json
import sys

import pytest
from conftest import git, tracked
from test_remote import remote_config

from wiki_rag import RagError, load_config, scan

PDF = b"%PDF-1.7\nsynthetic document\n%%EOF\n"


def pointer(data=PDF):
    return (
        "version https://git-lfs.github.com/spec/v1\n"
        f"oid sha256:{hashlib.sha256(data).hexdigest()}\nsize {len(data)}\n"
    )


def configured(tmp_path, repo, *, lfs=False, script=None, inputs=None, extra_args=()):
    remote_config(tmp_path, repo)
    path = tmp_path / "wiki-rag.toml"
    text = path.read_text()
    if lfs:
        text += "\nlfs = true\n"
    if script is not None:
        command = [sys.executable, *extra_args, "generate.py", "{output}"]
        text += (
            '\n[[collections.generators]]\nname = "api"\npath = "docs/llm/api"\n'
            f"command = {json.dumps(command)}\n"
            f"inputs = {json.dumps(inputs or ['input.md', 'generate.py'])}\n"
        )
    path.write_text(text)
    return load_config(path)


def prepare(cfg, **kwargs):
    from wiki_rag.sources import prepare_sources

    return prepare_sources(cfg, **kwargs)


def test_lfs_pointer_and_materialized_content_keep_verified_origin(tmp_path, repo):
    tracked(repo, "paper.pdf", pointer())
    git(repo, "commit", "-m", "pointer")
    cfg = configured(tmp_path, repo, lfs=True)
    with prepare(cfg, fetch_lfs=lambda *args: PDF) as ready:
        file = scan(ready)["guide"].files["paper.pdf"]
        assert file.content == PDF
        assert file.origin == {
            "kind": "git-lfs",
            "oid": hashlib.sha256(PDF).hexdigest(),
            "size": len(PDF),
        }
        assert file.source_commit == git(repo, "rev-parse", "HEAD")
        assert (repo / "paper.pdf").read_text() == pointer()
    (repo / "paper.pdf").write_bytes(PDF)
    with prepare(cfg) as ready:
        assert scan(ready)["guide"].files["paper.pdf"].content == PDF


def test_lfs_prefetch_budgets_and_hash_mismatch_fail(tmp_path, repo):
    tracked(repo, "paper.pdf", pointer())
    git(repo, "commit", "-m", "pointer")
    cfg = configured(tmp_path, repo, lfs=True)
    fetched = []

    def fetch(*args):
        fetched.append(args)
        return PDF

    with pytest.raises(RagError, match="size|budget|limit"):
        with prepare(dataclasses.replace(cfg, max_file_bytes=4), fetch_lfs=fetch):
            pass
    assert not fetched
    with pytest.raises(RagError, match="hash|size|LFS"):
        with prepare(cfg, fetch_lfs=lambda *args: PDF + b"tampered"):
            pass


def test_lfs_never_adopts_dirty_ordinary_tracked_bytes(tmp_path, repo):
    tracked(repo, "a.md", "committed")
    git(repo, "commit", "-m", "source")
    cfg = configured(tmp_path, repo, lfs=True)
    (repo / "a.md").write_text("dirty")
    with pytest.raises(RagError, match="HEAD|literal"):
        with prepare(cfg) as ready:
            scan(ready)


SCRIPT = """import sys
from pathlib import Path
out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
(out / "api.md").write_text(Path("input.md").read_text())
"""


def test_generated_inputs_are_isolated_and_outputs_are_not_git_blobs(tmp_path, repo, monkeypatch):
    script = (
        SCRIPT
        + """import os,json
names = ["TEST_INGEST_KEY","ACCESS_SECRET","PYTHONPATH"]
(out / "environment.md").write_text(json.dumps({k: k in os.environ for k in names}))
(out / "inventory.md").write_text(str(sorted(p.name for p in Path(".").rglob("*.py"))))
"""
    )
    tracked(repo, "input.md", "API documentation")
    tracked(repo, "generate.py", script)
    git(repo, "commit", "-m", "generator")
    (repo / "untracked.py").write_text("untracked input")
    (repo / "docs/llm/api").mkdir(parents=True)
    (repo / "docs/llm/api/stale.md").write_text("do not adopt")
    for name in ["TEST_INGEST_KEY", "ACCESS_SECRET", "PYTHONPATH"]:
        monkeypatch.setenv(name, "private-sentinel")
    cfg = configured(tmp_path, repo, script=script)
    with prepare(cfg) as ready:
        files = scan(ready)["guide"].files
        generated = files["docs/llm/api/api.md"]
        assert generated.content == b"API documentation"
        assert generated.origin["kind"] == "generated" and generated.origin["recipe"] == "api"
        assert generated.source_commit == git(repo, "rev-parse", "HEAD")
        assert "stale.md" not in " ".join(files)
        assert json.loads(files["docs/llm/api/environment.md"].content) == {
            "TEST_INGEST_KEY": False,
            "ACCESS_SECRET": False,
            "PYTHONPATH": False,
        }
        assert b"untracked.py" not in files["docs/llm/api/inventory.md"].content
        assert not (repo / "docs/llm/api/api.md").exists()


def test_generator_rejects_dirty_inputs_and_tracked_output_collision(tmp_path, repo):
    tracked(repo, "input.md", "hello")
    tracked(repo, "generate.py", SCRIPT)
    tracked(repo, "docs/llm/api/api.md", "tracked output")
    git(repo, "commit", "-m", "source")
    cfg = configured(tmp_path, repo, script=SCRIPT)
    with pytest.raises(RagError, match="collision|tracked"):
        with prepare(cfg):
            pass
    (repo / "input.md").write_text("dirty")
    with pytest.raises(RagError, match="HEAD|literal|input"):
        with prepare(cfg):
            pass


def test_generated_version_reuse_does_not_hide_preparation_identity(tmp_path, repo):
    tracked(repo, "input.md", "same output")
    tracked(repo, "generate.py", SCRIPT)
    git(repo, "commit", "-m", "source")
    cfg = configured(tmp_path, repo, script=SCRIPT)
    with prepare(cfg) as ready:
        before = scan(ready)["guide"]
    cfg = configured(tmp_path, repo, script=SCRIPT, extra_args=["-B"])
    with prepare(cfg) as ready:
        after = scan(ready)["guide"]
        assert (
            before.files["docs/llm/api/api.md"].version
            == after.files["docs/llm/api/api.md"].version
        )
        assert before.fingerprint != after.fingerprint


def test_generated_outputs_reject_symlinks(tmp_path, repo):
    script = SCRIPT + '(out / "unsafe.md").symlink_to(Path("input.md").resolve())\n'
    tracked(repo, "input.md", "hello")
    tracked(repo, "generate.py", script)
    git(repo, "commit", "-m", "source")
    cfg = configured(tmp_path, repo, script=script)
    with pytest.raises(RagError, match="symlink"):
        with prepare(cfg) as ready:
            scan(ready)


def test_remote_publication_preserves_derived_origin_and_reuses_content(
    tmp_path, repo, monkeypatch
):
    from test_engine import FakeProvider
    from test_remote import Authority, backend

    from wiki_rag import run

    tracked(repo, "input.md", "same")
    tracked(repo, "generate.py", SCRIPT)
    git(repo, "commit", "-m", "source")
    cfg = configured(tmp_path, repo, script=SCRIPT)
    authority, provider = Authority(cfg), FakeProvider()
    metadata = authority.metadata
    authority.metadata = lambda: {**metadata(), "features": ["async-submit-v1", "file-origin-v1"]}
    with backend(cfg, authority, monkeypatch) as remote:
        result = run(cfg, "index", apply=True, provider=provider, remote=remote)
        assert result["mode"] == "submitted"
    authority.complete(provider)
    file = authority.manifest["collections"]["guide"]["files"]["docs/llm/api/api.md"]
    assert file["origin"]["kind"] == "generated"
    assert (
        provider.attachments["vs_test", file["file_id"]]["attributes"]["source_kind"] == "generated"
    )
    uploads = provider.uploads
    cfg = configured(tmp_path, repo, script=SCRIPT, extra_args=["-B"])
    with backend(cfg, authority, monkeypatch) as remote:
        assert run(cfg, "index", apply=True, provider=provider, remote=remote)["mode"] == "applied"
    assert provider.uploads == uploads
    assert authority.manifest["collections"]["guide"]["files"]["docs/llm/api/api.md"] == file


def test_old_gate_rejects_derived_writes_and_cleanup_before_provider_mutation(
    tmp_path, repo, monkeypatch
):
    from test_engine import FakeProvider
    from test_remote import Authority, backend

    from wiki_rag import run

    tracked(repo, "paper.pdf", pointer())
    git(repo, "commit", "-m", "pointer")
    (repo / "paper.pdf").write_bytes(PDF)
    cfg = configured(tmp_path, repo, lfs=True)
    authority, provider = Authority(cfg), FakeProvider()
    with backend(cfg, authority, monkeypatch) as remote:
        with pytest.raises(RagError, match="file-origin-v1"):
            run(cfg, "index", apply=True, provider=provider, remote=remote)
    assert provider.uploads == 0 and provider.deleted == []


def test_empty_generator_is_not_treated_as_removal_of_all_previous_documents(tmp_path, repo):
    tracked(repo, "input.md", "hello")
    tracked(repo, "generate.py", "pass\n")
    git(repo, "commit", "-m", "generator")
    cfg = configured(tmp_path, repo, script="pass")
    with pytest.raises(RagError, match="no output"):
        with prepare(cfg):
            pass


def test_rescan_rejects_changed_generated_output_and_declared_input(tmp_path, repo):
    tracked(repo, "input.md", "hello")
    tracked(repo, "generate.py", SCRIPT)
    git(repo, "commit", "-m", "generator")
    cfg = configured(tmp_path, repo, script=SCRIPT)
    with prepare(cfg) as ready:
        (ready.prepared["generated"]["guide"][0]["root"] / "api.md").write_text("changed")
        with pytest.raises(RagError, match="outputs changed"):
            scan(ready)
    with prepare(cfg) as ready:
        (repo / "input.md").write_text("dirty")
        with pytest.raises(RagError, match="HEAD"):
            scan(ready)


def test_undeclared_dirty_configuration_is_not_visible_to_generator(tmp_path, repo):
    script = (
        SCRIPT
        + 'config = Path("settings.json")\n'
        + '(out / "config.md").write_text(config.read_text() if config.exists() else "absent")\n'
    )
    tracked(repo, "input.md", "hello")
    tracked(repo, "generate.py", script)
    tracked(repo, "settings.json", "committed")
    git(repo, "commit", "-m", "generator")
    (repo / "settings.json").write_text("undeclared dirty value")
    with prepare(configured(tmp_path, repo, script=script)) as ready:
        assert scan(ready)["guide"].files["docs/llm/api/config.md"].content == b"absent"


def test_lfs_aggregate_budget_precedes_transfer_and_small_payload_allows_pointer(tmp_path, repo):
    tracked(repo, "a.pdf", pointer())
    tracked(repo, "b.pdf", pointer())
    git(repo, "commit", "-m", "pointers")
    cfg = configured(tmp_path, repo, lfs=True)
    calls = []

    def fetch(*args):
        calls.append(args)
        return PDF

    with pytest.raises(RagError, match="limit"):
        with prepare(dataclasses.replace(cfg, max_total_bytes=len(PDF)), fetch_lfs=fetch):
            pass
    assert not calls
    with prepare(dataclasses.replace(cfg, max_file_bytes=len(PDF)), fetch_lfs=fetch) as ready:
        assert len(scan(ready)["guide"].files) == 2


def test_removing_last_derived_file_still_requires_capable_gate(tmp_path, repo, monkeypatch):
    from test_engine import FakeProvider
    from test_remote import Authority, backend

    from wiki_rag import run

    tracked(repo, "paper.pdf", pointer())
    git(repo, "commit", "-m", "pointer")
    (repo / "paper.pdf").write_bytes(PDF)
    cfg = configured(tmp_path, repo, lfs=True)
    authority = Authority(cfg)
    provider = FakeProvider()
    metadata = authority.metadata
    authority.metadata = lambda: {**metadata(), "features": ["async-submit-v1", "file-origin-v1"]}
    with backend(cfg, authority, monkeypatch) as remote:
        run(cfg, "index", apply=True, provider=provider, remote=remote)
    authority.complete(provider)
    authority.metadata = metadata
    cfg = dataclasses.replace(
        cfg, collections=(dataclasses.replace(cfg.collections[0], lfs=False, include=("**/*.md",)),)
    )
    with backend(cfg, authority, monkeypatch) as remote:
        with pytest.raises(RagError, match="file-origin-v1"):
            run(cfg, "index", apply=True, provider=provider, remote=remote)
    assert not provider.deleted


def test_orphan_derived_cleanup_requires_capability_before_delete(tmp_path, repo, monkeypatch):
    from test_engine import FakeProvider
    from test_remote import Authority, backend

    from wiki_rag import run

    tracked(repo, "paper.pdf", pointer())
    git(repo, "commit", "-m", "pointer")
    (repo / "paper.pdf").write_bytes(PDF)
    cfg = configured(tmp_path, repo, lfs=True)
    authority = Authority(cfg)
    provider = FakeProvider()
    metadata = authority.metadata
    authority.metadata = lambda: {**metadata(), "features": ["async-submit-v1", "file-origin-v1"]}
    with backend(cfg, authority, monkeypatch) as remote:
        run(cfg, "index", apply=True, provider=provider, remote=remote)
    assert authority.manifest is None
    next(iter(authority.ops.values()))["phase"] = "file_delete_pending"
    provider.attachments.clear()
    authority.metadata = metadata
    cfg = dataclasses.replace(
        cfg, collections=(dataclasses.replace(cfg.collections[0], lfs=False, include=("**/*.md",)),)
    )
    with backend(cfg, authority, monkeypatch) as remote:
        with pytest.raises(RagError, match="file-origin-v1"):
            run(cfg, "index", apply=True, provider=provider, remote=remote)
    assert not provider.deleted and set(provider.files) == {"file-1"}


@pytest.mark.parametrize(
    "name,content",
    [
        ("input.md", "-----BEGIN " + "PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----"),
        (".ssh/config", "synthetic"),
        (".aws/config", "synthetic"),
        (".gnupg/options", "synthetic"),
    ],
)
def test_generator_inputs_apply_secret_guards_before_execution(tmp_path, repo, name, content):
    script = (
        'import sys\nfrom pathlib import Path\nPath(sys.argv[1],"result.md").write_text("ok")\n'
    )
    tracked(repo, name, content)
    tracked(repo, "generate.py", script)
    git(repo, "commit", "-m", "inputs")
    cfg = configured(tmp_path, repo, script=script, inputs=[name, "generate.py"])
    with pytest.raises(RagError, match="secret"):
        with prepare(cfg):
            pass
