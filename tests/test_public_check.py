import importlib.util
from pathlib import Path

from conftest import git, tracked


def checker():
    script = Path(__file__).parents[1] / "scripts/check_public.py"
    spec = importlib.util.spec_from_file_location("public_check", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_release_check_rejects_secret_files_and_private_markers(repo):
    module = checker()
    tracked(repo, "README.md", "generic project")
    assert module.check_index(repo, ["private-company"])["findings"] == []
    tracked(repo, ".env", "placeholder")
    tracked(repo, "README.md", "private-company")
    assert len(module.check_index(repo, ["private-company"])["findings"]) == 2
    tracked(repo, "README.md", "sk-" + "a" * 32)
    assert "README.md: possible credential" in module.check_index(repo, [])["findings"]


def test_release_check_scans_staged_secret_after_working_tree_is_sanitized(repo):
    module = checker()
    path = tracked(repo, "README.md", "sk-" + "a" * 32)
    path.write_text("safe working-tree replacement")
    result = module.check_index(repo, [])
    assert result["findings"] == ["README.md: possible credential"]
    assert result["tree"] == git(repo, "write-tree")
    assert result["file_count"] == 1


def test_release_check_uses_staged_symlink_mode_even_after_replacement(repo):
    module = checker()
    path = repo / "README.md"
    path.symlink_to("elsewhere")
    git(repo, "add", "README.md")
    path.unlink()
    path.write_text("regular working file")
    assert module.check_index(repo, [])["findings"] == ["README.md: prohibited file or mode"]


def test_release_check_ignores_unstaged_edits_and_staged_deletions(repo):
    module = checker()
    tracked(repo, "README.md", "safe candidate").write_text("private-company")
    tracked(repo, "removed.md", "safe")
    git(repo, "rm", "--cached", "removed.md")
    (repo / "removed.md").write_text("private-company")
    result = module.check_index(repo, ["private-company"])
    assert result["findings"] == [] and result["file_count"] == 1
