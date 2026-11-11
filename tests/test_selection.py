import os

import pytest
from conftest import config_file, git, tracked


def api():
    import wiki_rag

    assert hasattr(wiki_rag, "load_config"), "strict config and scanner are not implemented"
    return wiki_rag


def test_strict_config_relative_paths_and_unknown_keys(tmp_path, repo):
    app = api()
    path = config_file(tmp_path, "repo")
    cfg = app.load_config(path)
    assert cfg.state == tmp_path / ".state"
    assert cfg.collections[0].root == repo
    path.write_text(path.read_text().replace("version = 1", "version = 1\nsurprise = true"))
    with pytest.raises(app.RagError, match="unknown"):
        app.load_config(path)


@pytest.mark.parametrize(
    "edit",
    [
        ("version = 1", "version = 2"),
        ('api_key_env = "TEST_INGEST_KEY"', 'api_key = "literal"'),
        ('project_id = "proj_test"', 'project_id = "https://other.example"'),
        ('extensions = [".md", ".rst", ".pdf"]', 'extensions = ["md"]'),
    ],
)
def test_invalid_config(tmp_path, repo, edit):
    app = api()
    path = config_file(tmp_path, repo)
    path.write_text(path.read_text().replace(*edit))
    with pytest.raises(app.RagError):
        app.load_config(path)


def test_selection_precedence_and_unsafe_sources(tmp_path, repo):
    app = api()
    tracked(repo, "README.md")
    tracked(repo, "docs/a.rst")
    tracked(repo, "private/no.md")
    tracked(repo, ".env.md")
    tracked(repo, "credentials.md")
    tracked(repo, "key.md", "-----BEGIN " + "PRIVATE KEY-----\nsecret")
    tracked(repo, "lfs.md", "version https://git-lfs.github.com/spec/v1\noid sha256:a\nsize 4\n")
    tracked(repo, "binary.md", b"%PDF\x00body")
    tracked(repo, "nested/doc.md")
    (repo / "nested/.git").mkdir()
    (repo / "link.md").symlink_to(repo / "README.md")
    git(repo, "add", "link.md")
    (repo / "untracked.md").write_text("never")
    snap = app.scan(app.load_config(config_file(tmp_path, repo)))
    assert set(snap["guide"].files) == {"README.md", "docs/a.rst"}
    reasons = {s["reason"] for s in snap["guide"].skipped}
    assert {"excluded", "secret", "lfs", "binary", "nested repository", "symlink"} <= reasons


def test_selected_read_error_and_limits_are_fatal(tmp_path, repo, monkeypatch):
    app = api()
    tracked(repo, "a.md", "too big")
    cfg = app.load_config(config_file(tmp_path, repo, extra="max_file_bytes = 3"))
    with pytest.raises(app.RagError, match="limit"):
        app.scan(cfg)
    cfg = app.load_config(config_file(tmp_path, repo))
    real_open = os.open

    def denied(path, *args, **kwargs):
        if str(path).endswith("a.md"):
            raise PermissionError("denied")
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(os, "open", denied)
    with pytest.raises(app.RagError, match="read"):
        app.scan(cfg)


def test_tracked_missing_file_is_deletion_but_missing_root_is_error(tmp_path, repo):
    app = api()
    tracked(repo, "a.md").unlink()
    cfg = app.load_config(config_file(tmp_path, repo))
    assert app.scan(cfg)["guide"].files == {}
    cfg.collections[0].root.rename(tmp_path / "moved")
    with pytest.raises(app.RagError):
        app.scan(cfg)


def test_glob_segments_and_gitlinks(tmp_path, repo):
    app = api()
    from wiki_rag.selection import matches

    assert matches("a.md", "**/*.md")
    assert matches("deep/a.md", "**/*.md")
    assert not matches("deep/a.md", "*.md")
    assert matches("deep/x/a.md", "deep/**/a.md")
    assert not matches("Deep/a.md", "deep/**")
    tracked(repo, "a.md")
    git(repo, "commit", "-m", "synthetic")
    commit = git(repo, "rev-parse", "HEAD")
    git(repo, "update-index", "--add", "--cacheinfo", f"160000,{commit},child")
    snap = app.scan(app.load_config(config_file(tmp_path, repo)))["guide"]
    assert {"path": "child", "reason": "submodule"} in snap.skipped


def test_missing_index_cannot_be_mass_deletion(tmp_path, repo):
    app = api()
    tracked(repo, "a.md")
    git(repo, "commit", "-m", "synthetic")
    (repo / ".git/index").unlink()
    with pytest.raises(app.RagError, match="index"):
        app.scan(app.load_config(config_file(tmp_path, repo)))


def test_git_inspection_disables_repository_fsmonitor(tmp_path, repo):
    app = api()
    tracked(repo, "README.md")
    marker = tmp_path / "executed"
    hook = tmp_path / "fsmonitor"
    hook.write_text(f"#!/bin/sh\ntouch '{marker}'\n")
    hook.chmod(0o700)
    git(repo, "config", "core.fsmonitor", str(hook))
    app.scan(app.load_config(config_file(tmp_path, repo)))
    assert not marker.exists(), "repository code must not run during source discovery"


def test_processing_change_is_a_new_version_and_unsupported_text_skips(tmp_path, repo):
    app = api()
    tracked(repo, "a.md")
    tracked(repo, "fake.pdf", "text is not a supported PDF handler")
    path = config_file(tmp_path, repo)
    first = app.scan(app.load_config(path))["guide"]
    assert {"path": "fake.pdf", "reason": "invalid PDF"} in first.skipped
    path.write_text(path.read_text().replace("version = 1", "version = 1\nchunk_size = 1000"))
    second = app.scan(app.load_config(path))["guide"]
    assert first.files["a.md"].version != second.files["a.md"].version


def test_explicit_branch_guard(tmp_path, repo):
    app = api()
    tracked(repo, "a.md")
    cfg = app.load_config(config_file(tmp_path, repo, collection_extra='branch = "other"'))
    with pytest.raises(app.RagError, match="branch"):
        app.scan(cfg)


def test_native_pdf_preserves_bytes_and_reports_invalid_pdf(tmp_path, repo):
    app = api()
    pdf = b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n\x00\n%%EOF\n"
    tracked(repo, "manual.pdf", pdf)
    tracked(repo, "invalid.pdf", b"a text file pretending to be a PDF")
    snap = app.scan(app.load_config(config_file(tmp_path, repo)))["guide"]
    assert "manual.pdf" in snap.files, "native PDF support is missing"
    assert snap.files["manual.pdf"].content == pdf
    assert snap.files["manual.pdf"].preprocessing == "pdf-native-v1"
    assert {"path": "invalid.pdf", "reason": "invalid PDF"} in snap.skipped


def test_sibling_root_and_parent_relative_state_are_normalized(tmp_path, repo):
    app = api()
    from wiki_rag.state import StateLock

    tracked(repo, "README.md")
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    path = config_file(config_dir, "../repo")
    path.write_text(path.read_text().replace('state = ".state"', 'state = "../state"'))
    cfg = app.load_config(path)
    assert cfg.collections[0].root == repo
    assert cfg.state == tmp_path / "state"
    assert set(app.scan(cfg)["guide"].files) == {"README.md"}
    with StateLock(cfg.state):
        assert (tmp_path / "state/.lock").is_file()


@pytest.mark.parametrize("field", ["root", "state"])
def test_parent_normalization_rejects_symlinks_in_cancelled_segments(tmp_path, repo, field):
    app = api()
    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "link").symlink_to(tmp_path, target_is_directory=True)
    path = config_file(config_dir, "../repo")
    if field == "root":
        path.write_text(path.read_text().replace('root = "../repo"', 'root = "link/../../repo"'))
    else:
        path.write_text(path.read_text().replace('state = ".state"', 'state = "link/../state"'))
    with pytest.raises(app.RagError, match="symlink"):
        app.load_config(path)


def test_symlinked_config_directory_is_rejected_before_read(tmp_path, repo):
    app = api()
    path = config_file(tmp_path, repo)
    link = tmp_path / "alias"
    link.symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(app.RagError, match="symlink"):
        app.load_config(link / ".." / path.name)


@pytest.mark.parametrize("extensions", [None, '[".md", ".py"]'])
def test_precise_includes_work_with_optional_extensions(tmp_path, repo, extensions):
    app = api()
    for name in ("README.md", "other.md", "src/a.py", "src/nested/b.py", "src/no.json"):
        tracked(repo, name)
    path = config_file(tmp_path, repo)
    text = path.read_text().replace(
        'include = ["**/*.md", "**/*.rst", "**/*.pdf"]', 'include = ["README.md", "src/**/*.py"]'
    )
    text = text.replace(
        'extensions = [".md", ".rst", ".pdf"]',
        "" if extensions is None else f"extensions = {extensions}",
    )
    path.write_text(text)
    assert set(app.scan(app.load_config(path))["guide"].files) == {
        "README.md",
        "src/a.py",
        "src/nested/b.py",
    }


@pytest.mark.parametrize("extensions", [None, '[".md"]'])
def test_optional_extensions_preserve_format_and_secret_filters(tmp_path, repo, extensions):
    app = api()
    for name, data in {
        "a.md": "hello",
        "b.py": "pass",
        "private/c.py": "excluded",
        ".env.py": "secret",
        "empty.md": "",
        "binary.py": b"a\x00b",
        "no.png": b"image",
        "valid.pdf": b"%PDF-1.7\nsynthetic\n%%EOF",
        "invalid.pdf": b"%PDF-invalid",
        "key.py": "-----BEGIN " + "PRIVATE KEY-----",
    }.items():
        tracked(repo, name, data)
    path = config_file(tmp_path, repo)
    text = path.read_text().replace(
        'include = ["**/*.md", "**/*.rst", "**/*.pdf"]', 'include = ["**/*"]'
    )
    text = text.replace(
        'extensions = [".md", ".rst", ".pdf"]',
        "" if extensions is None else f"extensions = {extensions}",
    )
    text = text.replace('exclude = ["private/**"]', 'exclude = ["private/**", "empty.md"]')
    path.write_text(text)
    expected = {"a.md", "b.py", "valid.pdf"} if extensions is None else {"a.md"}
    assert set(app.scan(app.load_config(path))["guide"].files) == expected


@pytest.mark.parametrize("value", ["[]", '["md"]', '[".MD"]', '".md"', "false", "[1]"])
def test_explicit_extensions_still_validate(tmp_path, repo, value):
    app = api()
    path = config_file(tmp_path, repo)
    path.write_text(
        path.read_text().replace('extensions = [".md", ".rst", ".pdf"]', f"extensions = {value}")
    )
    with pytest.raises(app.RagError):
        app.load_config(path)
