"""Deterministic Git index selection with no symlink or nested-repository traversal."""

import fnmatch
import hashlib
import json
import os
import re
import stat
import subprocess
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path, PurePosixPath

from .config import RagError

TEXT_SUFFIXES = frozenset(
    ".md .txt .rst .py .js .ts .tsx .jsx .json .yaml .yml .toml .csv "
    ".html .htm .css .xml .sql .sh .bash .c .h .cpp .hpp .java .go "
    ".rs .rb .php .swift .tex .log .ini .cfg .adoc".split()
)
SECRET_NAME = re.compile(
    r"(^\.env($|\.)|(^|[._-])(credentials?|secrets?|tokens?|id_rsa|id_ed25519)"
    r"($|[._-])|\.(pem|key|p12|pfx|keystore)$)",
    re.I,
)
SECRET_CONTENT = re.compile(
    rb"-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----"
    rb"|\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}"
    rb"|\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}"
)


def git(root, *args, required=True):
    try:
        result = subprocess.run(
            [
                "git",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.hooksPath=/dev/null",
                "-C",
                str(root),
                *args,
            ],
            capture_output=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RagError("Git source inspection failed") from exc
    if required and result.returncode:
        raise RagError("Git source inspection failed")
    return result


def digest(value):
    return hashlib.sha256(value).hexdigest()


def stable_hash(value):
    return digest(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def matches(path, pattern):
    """* and ? match within one segment; ** matches zero or more segments."""
    parts, pats = path.split("/"), pattern.split("/")

    @lru_cache(None)
    def walk(i, j):
        if j == len(pats):
            return i == len(parts)
        if pats[j] == "**":
            return walk(i, j + 1) or (i < len(parts) and walk(i + 1, j))
        return i < len(parts) and fnmatch.fnmatchcase(parts[i], pats[j]) and walk(i + 1, j + 1)

    return walk(0, 0)


def safe_read(root, relative, limit):
    """Open every ancestor relative to a no-follow descriptor, including the root."""
    descriptors = []
    try:
        fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
        descriptors.append(fd)
        for part in root.parts[1:] + PurePosixPath(relative).parts[:-1]:
            fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            descriptors.append(fd)
        fd = os.open(
            PurePosixPath(relative).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd
        )
        descriptors.append(fd)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise RagError("selected file is not regular")
        if limit is not None and info.st_size > limit:
            raise RagError("selected file exceeds size limit")
        with os.fdopen(os.dup(fd), "rb") as stream:
            data = stream.read() if limit is None else stream.read(limit + 1)
        if limit is not None and len(data) > limit:
            raise RagError("selected file exceeds size limit")
        return data
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise RagError("cannot safely read selected file") from exc
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


@dataclass
class SourceFile:
    path: str
    content: bytes
    sha256: str
    version: str
    kind: str
    source_commit: str | None
    preprocessing: str
    origin: dict | None = None


@dataclass
class Snapshot:
    files: dict[str, SourceFile]
    skipped: list[dict]
    commit: str | None
    prepared_identity: str | None = None

    @property
    def fingerprint(self):
        return stable_hash(
            {
                "commit": self.commit,
                "files": {p: f.version for p, f in self.files.items()},
                **({"prepared": self.prepared_identity} if self.prepared_identity else {}),
            }
        )


def content_reason(path, data):
    if data.startswith(b"version https://git-lfs.github.com/spec/v1"):
        return "lfs"
    if SECRET_CONTENT.search(data):
        return "secret"
    if Path(path).suffix.lower() == ".pdf":
        if not re.match(rb"%PDF-(?:1\.[0-7]|2\.0)(?:\r|\n)", data) or not data[
            -1024:
        ].rstrip().endswith(b"%%EOF"):
            return "invalid PDF"
    elif b"\0" in data:
        return "binary"
    elif Path(path).suffix.lower() not in TEXT_SUFFIXES:
        return "unsupported format"
    else:
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            return "binary"
    return None


def source_file(cfg, relative, data, commit, origin=None):
    from .origins import validate_origin

    preprocessing = "pdf-native-v1" if Path(relative).suffix.lower() == ".pdf" else "utf8-text-v1"
    processing = {**cfg.processing, "preprocessing": preprocessing}
    if origin is not None:
        validate_origin(origin)
        processing["source_kind"] = origin["kind"]
    sha = digest(data)
    return SourceFile(
        relative,
        data,
        sha,
        stable_hash([sha, processing]),
        Path(relative).suffix.lower()[1:],
        commit,
        preprocessing,
        origin,
    )


def scan(cfg):
    from .sources import generated_files, pointer

    snapshots = {}
    total = count = 0
    for collection in cfg.collections:
        root = collection.root
        if root.is_symlink() or not root.is_dir() or root.resolve() != root:
            raise RagError("collection root must be an existing non-symlink directory")
        actual = git(root, "rev-parse", "--show-toplevel").stdout.decode().strip()
        if Path(actual).resolve() != root:
            raise RagError("collection root must be a Git repository root")
        if collection.branch:
            branch = git(root, "symbolic-ref", "--quiet", "--short", "HEAD", required=False)
            if branch.returncode or branch.stdout.decode().strip() != collection.branch:
                raise RagError("source branch does not match configured branch")
        head = git(root, "rev-parse", "--verify", "HEAD", required=False)
        commit = head.stdout.decode().strip() if head.returncode == 0 else None
        index = git(root, "rev-parse", "--git-path", "index").stdout.decode().strip()
        if commit and not (root / index).is_file():
            raise RagError("Git index is missing; refusing to infer source deletions")
        records = git(root, "ls-files", "--stage", "-z").stdout.split(b"\0")
        if cfg.remote_state and (
            not commit
            or git(root, "rev-parse", "--is-shallow-repository").stdout.strip() != b"false"
        ):
            raise RagError("remote source requires committed full Git history")
        committed_blobs = {}
        committed_index = {}
        if commit:
            for entry in git(root, "ls-tree", "-r", "-z", "--full-tree", commit).stdout.split(
                b"\0"
            ):
                if entry:
                    metadata, name = entry.split(b"\t", 1)
                    mode, _, blob_id = metadata.split()
                    committed_blobs[name] = blob_id.decode()
                    committed_index[name] = (mode, blob_id, b"0")
        if cfg.remote_state:
            staged = {}
            for record in records:
                if record:
                    metadata, name = record.split(b"\t", 1)
                    staged[name] = tuple(metadata.split())
            if staged != committed_index:
                raise RagError("remote source Git index must match HEAD")
        files, skipped = {}, []
        generated, prepared_identity = generated_files(cfg, collection, commit)
        for record in records:
            if not record:
                continue
            try:
                meta, encoded = record.split(b"\t", 1)
                mode, _, stage = meta.decode().split()
                relative = encoded.decode("utf-8")
            except (ValueError, UnicodeError) as exc:
                raise RagError("invalid tracked path or Git index") from exc
            parts = PurePosixPath(relative).parts
            if not parts or relative.startswith("/") or ".." in parts or len(relative) > 512:
                raise RagError("unsupported tracked path")
            if stage != "0":
                raise RagError("unresolved Git index conflict")
            reason = None
            path = root / relative
            if mode == "160000":
                reason = "submodule"
            elif mode == "120000" or any(
                (root.joinpath(*parts[:n])).is_symlink() for n in range(1, len(parts) + 1)
            ):
                reason = "symlink"
            elif (
                ".git" in parts
                or cfg.state is not None
                and cfg.state.resolve()
                in (
                    path.resolve(),
                    *path.resolve().parents,
                )
            ):
                reason = "local state"
            elif any(SECRET_NAME.search(p) or p in {".ssh", ".aws", ".gnupg"} for p in parts):
                reason = "secret"
            elif any((root.joinpath(*parts[:n]) / ".git").exists() for n in range(1, len(parts))):
                reason = "nested repository"
            elif any(matches(relative, pat) for pat in collection.exclude):
                reason = "excluded"
            elif not any(matches(relative, pat) for pat in collection.include):
                reason = "not included"
            elif (
                collection.extensions is not None
                and path.suffix.lower() not in collection.extensions
            ):
                reason = "extension not allowed"
            if (
                cfg.remote_state
                and mode in {"100644", "100755"}
                and reason in {"symlink", "nested repository"}
                and ".git" not in parts
                and not any(SECRET_NAME.search(p) or p in {".ssh", ".aws", ".gnupg"} for p in parts)
                and not any(matches(relative, pat) for pat in collection.exclude)
                and any(matches(relative, pat) for pat in collection.include)
                and (collection.extensions is None or path.suffix.lower() in collection.extensions)
            ):
                # Working-tree boundaries cannot turn a selected HEAD regular file
                # into an unpublished deletion. Committed links remain exclusions.
                raise RagError("selected committed source has a working-tree substitution")
            if reason:
                skipped.append({"path": relative, "reason": reason})
                continue
            if cfg.remote_state and re.search(r"[\\%:#\x00-\x1f\x7f]", relative):
                raise RagError("invalid remote document path")
            derived = (
                cfg.prepared["lfs"].get((collection.name, relative))
                if collection.lfs and cfg.prepared
                else None
            )
            read_limit = cfg.max_file_bytes
            if derived and read_limit is not None:
                read_limit = max(read_limit, len(derived["pointer"]))
            data = safe_read(root, relative, read_limit)
            if data is None:
                if cfg.remote_state:
                    raise RagError("selected committed source was removed")
                skipped.append({"path": relative, "reason": "deleted from working tree"})
                continue
            origin = None
            proof_data = data
            if collection.lfs and cfg.prepared:
                if derived:
                    spec = pointer(derived["pointer"])
                    if (
                        derived["commit"] != commit
                        or spec != derived["origin"]
                        or data not in (derived["pointer"], derived["data"])
                        or len(derived["data"]) != spec["size"]
                        or digest(derived["data"]) != spec["oid"]
                    ):
                        raise RagError("LFS source changed after preparation")
                    proof_data, data, origin = derived["pointer"], derived["data"], spec
            if cfg.max_file_bytes is not None and len(data) > cfg.max_file_bytes:
                raise RagError("selected file exceeds size limit")
            algorithm = "sha256" if commit and len(commit) == 64 else "sha1"
            raw_blob = f"blob {len(proof_data)}\0".encode() + proof_data
            committed = hashlib.new(algorithm, raw_blob).hexdigest() == committed_blobs.get(encoded)
            if cfg.remote_state:
                if not committed:
                    raise RagError("remote source requires literal HEAD blob bytes")
            reason = content_reason(relative, data)
            if reason:
                skipped.append({"path": relative, "reason": reason})
                continue
            total += len(data)
            count += 1
            if (cfg.max_total_bytes is not None and total > cfg.max_total_bytes) or (
                cfg.max_files is not None and count > cfg.max_files
            ):
                raise RagError("selection exceeds total size or file count limit")
            if cfg.remote_state and count > 10000:
                raise RagError(
                    "remote manifest exceeds 10000 files (protocol limit; "
                    "unlimited selection does not remove it)"
                )
            files[relative] = source_file(
                cfg, relative, data, commit if committed else None, origin
            )
        for relative, data, origin in generated:
            if (
                relative in files
                or len(relative) > 512
                or re.search(r"[\\%:#\x00-\x1f\x7f]", relative)
            ):
                raise RagError("generated path is invalid or collides with a tracked document")
            reason = content_reason(relative, data)
            if reason:
                skipped.append({"path": relative, "reason": reason})
                continue
            total += len(data)
            count += 1
            if (
                (cfg.max_total_bytes is not None and total > cfg.max_total_bytes)
                or (cfg.max_files is not None and count > cfg.max_files)
                or cfg.remote_state
                and count > 10000
            ):
                raise RagError("selection exceeds total size or file count limit")
            files[relative] = source_file(cfg, relative, data, commit, origin)
        snapshots[collection.name] = Snapshot(
            dict(sorted(files.items())), skipped, commit, prepared_identity
        )
    return snapshots
