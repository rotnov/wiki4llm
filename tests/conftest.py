import subprocess

import pytest


def git(root, *args):
    return (
        subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)
        .stdout.decode()
        .strip()
    )


@pytest.fixture
def repo(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "-b", "main")
    git(root, "config", "user.email", "test@example.org")
    git(root, "config", "user.name", "Test")
    return root


def tracked(root, name, data="hello\n"):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, bytes):
        path.write_bytes(data)
    else:
        path.write_text(data)
    git(root, "add", "--", name)
    return path


def config_file(tmp_path, root, extra="", collection_extra=""):
    path = tmp_path / "wiki-rag.toml"
    path.write_text(f'''version = 1
state = ".state"
{extra}
[openai]
project_id = "proj_test"
api_key_env = "TEST_INGEST_KEY"
[[collections]]
name = "guide"
repository = "example/guide"
root = "{root}"
vector_store_id = "vs_test"
include = ["**/*.md", "**/*.rst", "**/*.pdf"]
extensions = [".md", ".rst", ".pdf"]
exclude = ["private/**"]
{collection_extra}
''')
    return path
