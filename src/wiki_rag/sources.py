"""Explicit, verified inputs for LFS objects and trusted documentation recipes."""

import os
import re
import signal
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from dataclasses import asdict, replace
from pathlib import Path

from .config import RagError
from .selection import SECRET_CONTENT, SECRET_NAME, digest, git, matches, safe_read, stable_hash


def pointer(data):
    match = re.fullmatch(
        rb"version https://git-lfs.github.com/spec/v1\n"
        rb"oid sha256:([a-f0-9]{64})\nsize (0|[1-9][0-9]*)\n",
        data,
    )
    if match:
        size = int(match[2])
        if size > 2**53 - 1:
            raise RagError("LFS object size exceeds supported bounds")
        return {"kind": "git-lfs", "oid": match[1].decode(), "size": size}
    if data.startswith(b"version https://git-lfs.github.com/spec/"):
        raise RagError("unsupported or malformed LFS pointer")
    return None


def eligible(collection, path):
    parts = path.split("/")
    return (
        not any(SECRET_NAME.search(p) or p in {".git", ".ssh", ".aws", ".gnupg"} for p in parts)
        and any(matches(path, p) for p in collection.include)
        and not any(matches(path, p) for p in collection.exclude)
        and (collection.extensions is None or Path(path).suffix.lower() in collection.extensions)
    )


def inventory(root):
    commit = git(root, "rev-parse", "--verify", "HEAD").stdout.decode().strip()
    entries = {}
    for item in git(root, "ls-tree", "-r", "-l", "-z", "--full-tree", commit).stdout.split(b"\0"):
        if item:
            meta, name = item.split(b"\t", 1)
            mode, _, oid, size = meta.split()
            entries[name.decode()] = (mode.decode(), oid.decode(), int(size) if size != b"-" else 0)
    return commit, entries


def inputs(collection, recipe):
    commit, entries = inventory(collection.root)
    selected = {}
    for path, (mode, oid, _) in entries.items():
        if not any(matches(path, p) for p in recipe.inputs):
            continue
        if any(SECRET_NAME.search(p) or p in {".ssh", ".aws", ".gnupg"} for p in path.split("/")):
            raise RagError("generator input matches a secret path guard")
        if (
            mode not in {"100644", "100755"}
            or path.startswith("/")
            or any(p in {".", "..", ".git"} for p in path.split("/"))
        ):
            raise RagError("generator input must be an ordinary tracked file")
        data = git(collection.root, "cat-file", "blob", oid).stdout
        if SECRET_CONTENT.search(data):
            raise RagError("generator input matches a secret content guard")
        if pointer(data):
            raise RagError("generator inputs must be literal Git blobs, not LFS pointers")
        if safe_read(collection.root, path, None) != data:
            raise RagError("generator input requires literal HEAD bytes")
        selected[path] = (data, mode)
    if not selected:
        raise RagError("generator inputs matched no committed files")
    return commit, selected, stable_hash({p: digest(v[0]) for p, v in sorted(selected.items())})


def run_recipe(recipe, cwd, output):
    env = {
        k: v
        for k, v in os.environ.items()
        if k
        in {
            "PATH",
            "HOME",
            "USER",
            "LANG",
            "LC_ALL",
            "TMPDIR",
            "SYSTEMROOT",
            "UV_CACHE_DIR",
            "UV_PYTHON_CACHE_DIR",
            "UV_PYTHON_INSTALL_DIR",
        }
    }
    argv = [str(output) if arg == "{output}" else arg for arg in recipe.command]
    try:
        with subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        ) as process:
            try:
                code = process.wait(timeout=180)
            except BaseException:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                raise
        if code:
            raise RagError("documentation generator failed; no output was accepted")
    except OSError, subprocess.TimeoutExpired:
        raise RagError("documentation generator failed or timed out") from None


def output_inventory(root, limit):
    result = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            if path.is_symlink():
                raise RagError("generated output must not contain symlinks")
            if name == ".git":
                raise RagError("generated output must not contain nested repositories")
        for name in files:
            relative = (Path(directory) / name).relative_to(root).as_posix()
            data = safe_read(root, relative, limit)
            if data is None:
                raise RagError("generated output changed during inspection")
            result[relative] = digest(data)
            if len(result) > 10000:
                raise RagError("generated output exceeds file count limit")
    return result


def check_budget(cfg, sizes):
    if (
        cfg.max_files is not None
        and len(sizes) > cfg.max_files
        or cfg.remote_state
        and len(sizes) > 10000
        or cfg.max_total_bytes is not None
        and sum(sizes) > cfg.max_total_bytes
        or cfg.max_file_bytes is not None
        and any(n > cfg.max_file_bytes for n in sizes)
    ):
        raise RagError("derived sources exceed selection size or file count limit")


@contextmanager
def prepare_sources(cfg, *, fetch_lfs=None):
    if cfg.prepared is not None or not any(c.lfs or c.generators for c in cfg.collections):
        yield cfg
        return
    prepared = {"lfs": {}, "generated": {}}
    sizes, pending = [], []
    with tempfile.TemporaryDirectory(prefix="wiki-rag-derived-") as directory:
        temporary = Path(directory).resolve()
        for ci, collection in enumerate(cfg.collections):
            commit, entries = inventory(collection.root)
            for path, (mode, oid, size) in entries.items():
                if mode not in {"100644", "100755"} or not eligible(collection, path):
                    continue
                spec = None
                if collection.lfs and size < 1024:
                    raw = git(collection.root, "cat-file", "blob", oid).stdout
                    spec = pointer(raw)
                if spec:
                    sizes.append(spec["size"])
                    pending.append((collection, path, raw, spec, commit))
                else:
                    sizes.append(size)
            for gi, recipe in enumerate(collection.generators):
                source_commit, data, inputs_hash = inputs(collection, recipe)
                source = temporary / f"inputs-{ci}-{gi}"
                output = temporary / f"output-{ci}-{gi}"
                source.mkdir()
                output.mkdir()
                for path, (content, mode) in data.items():
                    target = source / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(content)
                    target.chmod(0o755 if mode == "100755" else 0o644)
                run_recipe(recipe, source, output)
                for path, (content, _) in data.items():
                    if safe_read(source, path, None) != content:
                        raise RagError("generator mutated its committed inputs")
                if inputs(collection, recipe)[2] != inputs_hash:
                    raise RagError("generator inputs changed")
                outputs = output_inventory(output, cfg.max_file_bytes)
                if not outputs:
                    raise RagError("documentation generator produced no output")
                for path in outputs:
                    virtual = recipe.path + "/" + path
                    if virtual in entries:
                        raise RagError("generated output collision with a tracked file")
                    if eligible(collection, virtual):
                        sizes.append((output / path).stat().st_size)
                prepared["generated"].setdefault(collection.name, []).append(
                    {
                        "recipe": recipe,
                        "root": output,
                        "outputs": outputs,
                        "commit": source_commit,
                        "origin": {
                            "kind": "generated",
                            "recipe": recipe.name,
                            "recipe_sha256": stable_hash(asdict(recipe)),
                            "inputs_sha256": inputs_hash,
                        },
                    }
                )
                print(
                    f"wiki-rag: prepared generator {recipe.name} ({len(outputs)} files)",
                    file=sys.stderr,
                )
        check_budget(cfg, sizes)
        for collection, path, raw, spec, commit in pending:
            data = safe_read(collection.root, path, max(len(raw), spec["size"]))
            if data == raw:
                common = (
                    git(collection.root, "rev-parse", "--git-common-dir").stdout.decode().strip()
                )
                objects = (collection.root / common).resolve() / "lfs" / "objects"
                relative = f"{spec['oid'][:2]}/{spec['oid'][2:4]}/{spec['oid']}"
                data = safe_read(objects, relative, spec["size"]) if objects.exists() else None
                if data is None and fetch_lfs is not None:
                    data = fetch_lfs(collection, path, raw, spec)
            if data is None or len(data) != spec["size"] or digest(data) != spec["oid"]:
                raise RagError("LFS object missing or its hash/size does not match HEAD")
            prepared["lfs"][collection.name, path] = {
                "data": data,
                "pointer": raw,
                "origin": spec,
                "commit": commit,
            }
        if pending:
            print(f"wiki-rag: verified LFS content ({len(pending)} files)", file=sys.stderr)
        yield replace(cfg, prepared=prepared)


def generated_files(cfg, collection, commit):
    if cfg.prepared is None:
        if collection.generators or collection.lfs:
            raise RagError("derived sources require preparation before scanning")
        return [], None
    records = cfg.prepared["generated"].get(collection.name, [])
    if tuple(r["recipe"] for r in records) != collection.generators:
        raise RagError("generator recipe changed after preparation")
    files, identities = [], []
    for record in records:
        recipe = record["recipe"]
        if (
            record["commit"] != commit
            or inputs(collection, recipe)[2] != record["origin"]["inputs_sha256"]
        ):
            raise RagError("generator inputs changed after preparation")
        if output_inventory(record["root"], cfg.max_file_bytes) != record["outputs"]:
            raise RagError("generated outputs changed after preparation")
        identities.append([record["origin"], record["outputs"]])
        for relative in record["outputs"]:
            path = recipe.path + "/" + relative
            if eligible(collection, path):
                files.append(
                    (
                        path,
                        safe_read(record["root"], relative, cfg.max_file_bytes),
                        record["origin"],
                    )
                )
    return files, stable_hash(identities) if records else None
