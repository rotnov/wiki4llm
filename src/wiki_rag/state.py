"""Private durable journal and independent atomic published registry (POSIX hosts)."""

import fcntl
import json
import os
import re
import tempfile
import uuid
from pathlib import Path

from .config import RagError
from .selection import stable_hash


def atomic_json(path, value):
    fd, temporary = tempfile.mkstemp(prefix=".tmp-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class StateLock:
    def __init__(self, directory):
        self.directory = directory
        self.fd = None

    def __enter__(self):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.directory.is_symlink() or self.directory.resolve() != self.directory:
            raise RagError("state directory must not traverse symlinks")
        if self.directory.stat().st_mode & 0o077:
            raise RagError("state directory must be private (mode 0700)")
        self.fd = os.open(self.directory / ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            os.close(self.fd)
            self.fd = None
            raise RagError("state is locked by another process") from exc
        return self

    def __exit__(self, *args):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


def load_state(cfg):
    path = cfg.state / "state.json"
    if not path.exists():
        if (cfg.state / ".initialized").exists() or (cfg.state / "manifest.json").exists():
            raise RagError("ownership state missing; restore durable state before applying")
        return None
    try:
        if path.is_symlink():
            raise ValueError()
        envelope = json.loads(path.read_text())
        data = envelope["data"]
        if envelope["sha256"] != stable_hash(data) or data["schema_version"] != 1:
            raise ValueError()
        if not isinstance(data["operations"], dict):
            raise ValueError()
        if data["ownership"] != cfg.ownership:
            raise RagError("state ownership mismatch; restore original configuration")
        return data
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise RagError("invalid or corrupt ownership state") from exc


def save_state(cfg, state):
    atomic_json(cfg.state / "state.json", {"sha256": stable_hash(state), "data": state})


def read_manifest(path):
    """Read one complete publication; never return journaled/staged operations."""
    try:
        data = json.loads(Path(path).read_text())
        if (
            data["schema_version"] != 1
            or not isinstance(data["project_id"], str)
            or not isinstance(data["publication_id"], str)
            or type(data["generation"]) is not int
            or data["generation"] < 0
            or not isinstance(data["collections"], dict)
        ):
            raise ValueError()
        uuid.UUID(data["publication_id"])
        if not re.fullmatch(r"proj_[A-Za-z0-9_-]+", data["project_id"]):
            raise ValueError()
        if data["generation"] > 0 and not isinstance(data["published_at"], str):
            raise ValueError()
        for name, collection in data["collections"].items():
            if (
                not isinstance(collection["repository"], str)
                or collection["branch"] is not None
                and not isinstance(collection["branch"], str)
                or not isinstance(collection["processing"], dict)
                or collection["repository_commit"] is not None
                and not re.fullmatch(r"[0-9a-f]{40,64}", collection["repository_commit"])
            ):
                raise ValueError()
            if not isinstance(name, str) or not isinstance(collection["files"], dict):
                raise ValueError()
            for path, item in collection["files"].items():
                if (
                    item["path"] != path
                    or path.startswith("/")
                    or ".." in path.split("/")
                    or item["vector_store_id"] != collection["vector_store_id"]
                    or not isinstance(item["file_id"], str)
                    or not re.fullmatch(r"file-[A-Za-z0-9_-]+", item["file_id"])
                    or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"])
                    or not re.fullmatch(r"[0-9a-f]{64}", item["version"])
                    or item["preprocessing"] not in {"utf8-text-v1", "pdf-native-v1"}
                    or not isinstance(item["kind"], str)
                    or item["source_commit"] is not None
                    and not re.fullmatch(r"[0-9a-f]{40,64}", item["source_commit"])
                ):
                    raise ValueError()
        return data
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise RagError("missing or invalid published manifest") from exc


def is_active(manifest, project_id, collection_name, vector_store_id, file_id):
    """Gate allowlist predicate; authorization must precede this freshness check."""
    if manifest.get("project_id") != project_id:
        return False
    collection = manifest.get("collections", {}).get(collection_name, {})
    return collection.get("vector_store_id") == vector_store_id and any(
        f.get("file_id") == file_id and f.get("vector_store_id") == vector_store_id
        for f in collection.get("files", {}).values()
    )
