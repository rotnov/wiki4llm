import dataclasses
import subprocess

import pytest
from conftest import git, tracked
from test_derived_sources import PDF, configured, pointer

from wiki_rag import RagError
from wiki_rag.github_actions import git_environment


def test_lfs_transfer_pins_endpoint_and_credentials_to_git_subprocess(tmp_path, repo, monkeypatch):
    from wiki_rag.github_actions import fetch_lfs_object
    from wiki_rag.sources import pointer as parse_pointer

    tracked(repo, "paper.pdf", pointer())
    tracked(repo, ".lfsconfig", "[lfs]\nurl = https://attacker.invalid/lfs\n")
    git(repo, "commit", "-m", "source")
    collection = configured(tmp_path, repo, lfs=True).collections[0]
    seen = []

    def execute(argv, **kwargs):
        seen.append((argv, kwargs["env"]))
        assert kwargs["input"] == pointer().encode()
        kwargs["stdout"].write(PDF)
        return subprocess.CompletedProcess(argv, 0)

    monkeypatch.setattr(subprocess, "run", execute)
    with git_environment():
        result = fetch_lfs_object(
            collection,
            "paper.pdf",
            pointer().encode(),
            parse_pointer(pointer().encode()),
            "synthetic-checkout",
        )
    assert result == PDF and len(seen) == 1
    argv, env = seen[0]
    assert "synthetic-checkout" not in " ".join(argv)
    assert argv[-3:] == ["smudge", "--", "paper.pdf"]
    settings = {
        env[f"GIT_CONFIG_KEY_{i}"]: env[f"GIT_CONFIG_VALUE_{i}"]
        for i in range(int(env["GIT_CONFIG_COUNT"]))
    }
    assert (
        settings["lfs.url"]
        == settings["remote.origin.lfsurl"]
        == "https://github.com/example/guide.git/info/lfs"
    )
    assert settings["lfs.basictransfersonly"] == "true"
    assert settings["lfs.remote.autodetect"] == "false"
    assert settings["lfs.standalonetransferagent"] == ""
    assert "http.https://github.com/.extraheader" in settings and "http.extraheader" not in settings


def test_lfs_transfer_rejects_non_github_identity(tmp_path, repo):
    from wiki_rag.github_actions import fetch_lfs_object
    from wiki_rag.sources import pointer as parse_pointer

    collection = configured(tmp_path, repo, lfs=True).collections[0]
    collection = dataclasses.replace(collection, repository="../other")
    with pytest.raises(RagError, match="repository"):
        fetch_lfs_object(
            collection,
            "paper.pdf",
            pointer().encode(),
            parse_pointer(pointer().encode()),
            "synthetic",
        )
