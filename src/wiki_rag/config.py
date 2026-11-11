"""Strict TOML configuration; paths are relative to the configuration file."""

import re
import stat
import tomllib
from dataclasses import dataclass
from pathlib import Path


class RagError(Exception):
    """A safe, user-facing error with no provider body or credentials."""


def keys(obj, allowed, required=()):
    if not isinstance(obj, dict) or set(obj) - set(allowed):
        raise RagError("unknown configuration field or invalid table")
    if set(required) - set(obj):
        raise RagError("missing required configuration field")


def string(value, pattern=None):
    if not isinstance(value, str) or not value or len(value) > 512:
        raise RagError("invalid configuration string")
    if pattern and not re.fullmatch(pattern, value):
        raise RagError("invalid configuration identifier")
    return value


def integer(value, minimum, maximum):
    if type(value) is not int or not minimum <= value <= maximum:
        raise RagError("integer outside configured bounds")
    return value


def selection_limit(value, maximum):
    """Disable a budget with integer -1 or the legacy string alias."""
    if (type(value) is int and value == -1) or value == "unlimited":
        return None
    return integer(value, 1, maximum)


def patterns(value):
    if not isinstance(value, list) or not all(isinstance(x, str) and x for x in value):
        raise RagError("glob list must contain strings")
    for item in value:
        if item.startswith("/") or "\\" in item or ".." in item.split("/"):
            raise RagError("globs must use normalized relative POSIX paths")
        if any("**" in p and p != "**" for p in item.split("/")):
            raise RagError("** must occupy a whole path segment")
    return tuple(value)


@dataclass(frozen=True)
class Collection:
    name: str
    repository: str
    root: Path
    vector_store_id: str
    branch: str | None
    include: tuple[str, ...]
    exclude: tuple[str, ...]
    extensions: tuple[str, ...]

    def binding(self):
        return {
            "repository": self.repository,
            "branch": self.branch,
            "vector_store_id": self.vector_store_id,
        }


@dataclass(frozen=True)
class RemoteConfig:
    origin_env: str
    workspace: str
    client_id_env: str
    client_secret_env: str
    lease_wait_seconds: int = 300


@dataclass(frozen=True)
class Config:
    project_id: str
    api_key_env: str
    state: Path | None
    collections: tuple[Collection, ...]
    max_file_bytes: int | None
    max_total_bytes: int | None
    max_files: int | None
    chunk_size: int
    chunk_overlap: int

    remote_state: RemoteConfig | None = None

    @property
    def processing(self):
        return {
            "preprocessing": "per-file-v1",
            "chunking": {
                "type": "static",
                "static": {
                    "max_chunk_size_tokens": self.chunk_size,
                    "chunk_overlap_tokens": self.chunk_overlap,
                },
            },
        }

    @property
    def ownership(self):
        return {
            "project_id": self.project_id,
            "collections": {c.name: c.binding() for c in self.collections},
        }


def lexical_path(path):
    """Collapse parent segments only after checking every encountered existing component."""
    parts = Path(path).absolute().parts
    current = Path("/")
    for index, part in enumerate(parts[1:], start=1):
        if part == "..":
            current = current.parent
            continue
        candidate = current / part
        try:
            mode = candidate.lstat().st_mode
        except FileNotFoundError:
            mode = None
        except OSError as exc:
            raise RagError("cannot inspect configured path") from exc
        if mode is not None:
            if stat.S_ISLNK(mode):
                raise RagError(
                    "configured path must not traverse symlinks, even before parent segments"
                )
            if index < len(parts) - 1 and not stat.S_ISDIR(mode):
                raise RagError("configured path ancestor is not a directory")
        current = candidate
    return current


def load_config(path):
    path = lexical_path(path)
    try:
        raw = tomllib.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise RagError("cannot read valid TOML configuration") from exc
    return config_from_mapping(raw, path)


def config_from_mapping(raw, path):
    """Validate either a TOML document or explicitly supplied workflow parameters."""
    path = lexical_path(path)
    keys(
        raw,
        {
            "version",
            "state",
            "remote_state",
            "openai",
            "collections",
            "max_file_bytes",
            "max_total_bytes",
            "max_files",
            "chunk_size",
            "chunk_overlap",
        },
        {"version", "openai", "collections"},
    )
    if type(raw["version"]) is not int or raw["version"] != 1:
        raise RagError("unsupported config version")
    keys(raw["openai"], {"project_id", "api_key_env"}, {"project_id", "api_key_env"})
    project = string(raw["openai"]["project_id"], r"proj_[A-Za-z0-9_-]+")
    env = string(raw["openai"]["api_key_env"], r"[A-Za-z_][A-Za-z0-9_]*")
    if ("state" in raw) == ("remote_state" in raw):
        raise RagError("configure exactly one of state or remote_state")
    remote = None
    state = None
    if "state" in raw:
        state = lexical_path(path.parent / string(raw["state"]))
    else:
        item = raw["remote_state"]
        required = {"origin_env", "workspace", "client_id_env", "client_secret_env"}
        keys(item, required | {"lease_wait_seconds"}, required)
        remote = RemoteConfig(
            string(item["origin_env"], r"[A-Z][A-Z0-9_]{0,127}"),
            string(item["workspace"], r"[a-z0-9]+(?:-[a-z0-9]+)*"),
            string(item["client_id_env"], r"[A-Z][A-Z0-9_]{0,127}"),
            string(item["client_secret_env"], r"[A-Z][A-Z0-9_]{0,127}"),
            integer(item.get("lease_wait_seconds", 300), 0, 1800),
        )
        if len(remote.workspace) > 80:
            raise RagError("remote workspace identifier too long")
    collections = []
    if not isinstance(raw["collections"], list) or not raw["collections"]:
        raise RagError("at least one collection required")
    for item in raw["collections"]:
        keys(
            item,
            {
                "name",
                "repository",
                "root",
                "vector_store_id",
                "branch",
                "include",
                "exclude",
                "extensions",
            },
            {"name", "repository", "root", "vector_store_id", "include", "extensions"},
        )
        ext = patterns(item["extensions"])
        if not ext or any(not re.fullmatch(r"\.[a-z0-9]+", e) for e in ext):
            raise RagError("extensions require lowercase dotted suffixes")
        collections.append(
            Collection(
                string(item["name"], r"[a-zA-Z0-9_-]+"),
                string(item["repository"]),
                lexical_path(path.parent / string(item["root"])),
                string(item["vector_store_id"], r"vs_[A-Za-z0-9_-]+"),
                string(item["branch"]) if "branch" in item else None,
                patterns(item["include"]),
                patterns(item.get("exclude", [])),
                ext,
            )
        )
    if len({c.name for c in collections}) != len(collections):
        raise RagError("duplicate collection name")
    if remote and (
        len(collections) > 20
        or len({c.vector_store_id for c in collections}) != len(collections)
        or any(
            not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", c.name) or len(c.name) > 80
            for c in collections
        )
    ):
        raise RagError("invalid remote collection bindings")
    size = integer(raw.get("chunk_size", 800), 100, 4096)
    overlap = integer(raw.get("chunk_overlap", 400), 0, size // 2)
    return Config(
        project,
        env,
        state,
        tuple(collections),
        selection_limit(raw.get("max_file_bytes", 2_000_000), 20_000_000),
        selection_limit(raw.get("max_total_bytes", 50_000_000), 200_000_000),
        selection_limit(raw.get("max_files", 10000), 100000),
        size,
        overlap,
        remote,
    )
