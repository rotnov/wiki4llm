"""Stage, reconcile, publish, then clean up only resources owned by this journal."""

import uuid
from datetime import datetime, timezone

from .config import RagError
from .provider import RejectedWrite, TerminalIngestionFailure
from .selection import git, scan, stable_hash
from .state import StateLock, atomic_json, load_state, read_manifest, save_state


def OpenAIProvider(cfg):
    from .provider import OpenAIProvider as Provider

    return Provider(cfg)


def empty_manifest(cfg):
    return {
        "schema_version": 1,
        "project_id": cfg.project_id,
        "publication_id": str(uuid.uuid4()),
        "generation": 0,
        "published_at": None,
        "collections": {},
    }


def manifest_for(cfg, state):
    if state is None:
        return empty_manifest(cfg)
    manifest = read_manifest(cfg.state / "manifest.json")
    if manifest["project_id"] != cfg.project_id:
        raise RagError("manifest project ownership mismatch")
    for name, collection in manifest["collections"].items():
        binding = cfg.ownership["collections"].get(name)
        if not binding or any(collection.get(k) != v for k, v in binding.items()):
            raise RagError("manifest collection ownership mismatch")
        for item in collection["files"].values():
            op = state["operations"].get(item["operation_id"])
            if (
                not op
                or op.get("file_id") != item["file_id"]
                or op["phase"] != "complete"
                or op["store"] != item["vector_store_id"]
            ):
                raise RagError("manifest file missing from ownership state")
    return manifest


def plan(cfg, snapshots, manifest):
    result = {"mode": "preview", "network_requests": 0, "collections": {}}
    for collection in cfg.collections:
        snap = snapshots[collection.name]
        before = manifest["collections"].get(collection.name, {}).get("files", {})
        changes = []
        for path, file in snap.files.items():
            if path not in before:
                changes.append({"path": path, "action": "add", "reason": "new logical path"})
            elif before[path]["version"] != file.version:
                changes.append(
                    {"path": path, "action": "replace", "reason": "content or processing changed"}
                )
        for path in sorted(set(before) - set(snap.files)):
            reason = next(
                (s["reason"] for s in snap.skipped if s["path"] == path), "no longer Git-tracked"
            )
            changes.append({"path": path, "action": "delete", "reason": reason})
        result["collections"][collection.name] = {
            "selected_files": len(snap.files),
            "selected_bytes": sum(len(f.content) for f in snap.files.values()),
            "changes": changes,
            "skipped": snap.skipped,
            "repository_commit": snap.commit,
        }
    return result


def guard_commits(cfg, snapshots, manifest):
    for collection in cfg.collections:
        previous = manifest["collections"].get(collection.name, {}).get("repository_commit")
        current = snapshots[collection.name].commit
        if previous and (
            not current
            or git(
                collection.root, "merge-base", "--is-ancestor", previous, current, required=False
            ).returncode
        ):
            raise RagError("stale or divergent source commit; forward ancestry required")


def checkpoint(cfg, state, oid, operation, retired_id=None):
    """Explicit operation delta; local state retains its existing atomic envelope."""
    remote = state.get("_remote")
    if remote:
        remote.checkpoint(oid, operation, retired_id)
    else:
        save_state(cfg, state)


def mutation(state, provider, method, *args):
    remote = state.get("_remote")
    if remote:
        remote.guard()
    return getattr(provider, method)(*args)


def stage_file(cfg, state, collection, snap, file, provider):
    operation_id = stable_hash(
        [
            cfg.project_id,
            collection.name,
            collection.repository,
            collection.branch,
            file.path,
            file.version,
        ]
    )
    operations = state["operations"]
    op = operations.get(operation_id)
    ingestion_attempts = 1
    if op and op.get("terminal_failure"):
        if op.get("ingestion_attempts", 1) >= 3:
            raise RagError(
                "terminal ingestion retry limit reached; operator investigation required"
            )
        ingestion_attempts = op.get("ingestion_attempts", 1) + 1
    retired_id = None
    if op and op["phase"] in {
        "ingestion_failed",
        "detach_pending",
        "detached",
        "file_delete_pending",
        "deleted",
    }:
        retire(cfg, state, operation_id, op, provider)
        # Keep the retired ownership receipt before reusing this logical version key.
        retired_id = f"{operation_id}.retired.{uuid.uuid4().hex}"
        if not state.get("_remote"):
            operations[retired_id] = op
            del operations[operation_id]
        op = None
    if op is None:
        op = {
            "filename": f"wiki-rag-{uuid.uuid4().hex}" + (".pdf" if file.kind == "pdf" else ".txt"),
            "phase": "upload_ready",
            "store": collection.vector_store_id,
            "collection": collection.name,
            "sha256": file.sha256,
            "path": file.path,
            "version": file.version,
            "source_commit": file.source_commit,
            "ingestion_attempts": ingestion_attempts,
        }
        if not state.get("_remote"):
            operations[operation_id] = op
        checkpoint(cfg, state, operation_id, op, retired_id)
    if op["phase"] == "upload_ready":
        op["phase"] = "upload_pending"
        checkpoint(cfg, state, operation_id, op)
        # This create is deliberately attempted once. The intent survives even SIGKILL.
        try:
            op["file_id"] = mutation(state, provider, "upload", op["filename"], file.content)
        except RejectedWrite:
            op["phase"] = "upload_ready"
            checkpoint(cfg, state, operation_id, op)
            raise
        op["phase"] = "uploaded"
        checkpoint(cfg, state, operation_id, op)
    elif op["phase"] == "upload_pending":
        op["file_id"] = provider.reconcile_upload(op["filename"], op["sha256"])
        op["phase"] = "uploaded"
        checkpoint(cfg, state, operation_id, op)
    attributes = {
        "repository": collection.repository,
        "path": file.path,
        "commit": op["source_commit"] or "working-tree",
        "kind": file.kind,
        "collection": collection.name,
        "branch": collection.branch or "unspecified",
        "sha256": file.sha256,
        "operation_id": operation_id,
    }
    if op["phase"] == "uploaded":
        op["phase"] = "attach_pending"
        checkpoint(cfg, state, operation_id, op)
        try:
            mutation(
                state,
                provider,
                "attach",
                op["store"],
                op["file_id"],
                attributes,
                cfg.processing["chunking"],
            )
        except RejectedWrite:
            op["phase"] = "uploaded"
            checkpoint(cfg, state, operation_id, op)
            raise
        op["phase"] = "attached"
        checkpoint(cfg, state, operation_id, op)
    elif op["phase"] == "attach_pending":
        attached = provider.attachment(op["store"], op["file_id"])
        if not attached or attached.get("attributes", {}).get("operation_id") != operation_id:
            raise RagError("unresolved attachment outcome; retry reconciliation later")
        op["phase"] = "attached"
        checkpoint(cfg, state, operation_id, op)
    if op["phase"] == "attached":
        try:
            provider.wait_completed(op["store"], op["file_id"])
        except TerminalIngestionFailure:
            op["phase"] = "ingestion_failed"
            op["terminal_failure"] = True
            checkpoint(cfg, state, operation_id, op)
            raise
        op["phase"] = "complete"
        checkpoint(cfg, state, operation_id, op)
    return {
        "file_id": op["file_id"],
        "vector_store_id": op["store"],
        "path": file.path,
        "sha256": file.sha256,
        "version": file.version,
        "kind": file.kind,
        "source_commit": op["source_commit"],
        "preprocessing": file.preprocessing,
        "operation_id": operation_id,
    }


def retire(cfg, state, oid, op, provider):
    """Complete idempotent retirement; every remote delete has a durable prior intent."""
    if op["phase"] == "deleted":
        return
    if op["phase"] not in {"detached", "file_delete_pending"}:
        op["phase"] = "detach_pending"
        checkpoint(cfg, state, oid, op)
        mutation(state, provider, "delete_attachment", op["store"], op["file_id"])
        op["phase"] = "detached"
        checkpoint(cfg, state, oid, op)
    if op["phase"] == "detached":
        op["phase"] = "file_delete_pending"
        checkpoint(cfg, state, oid, op)
    mutation(state, provider, "delete_file", op["file_id"])
    op["phase"] = "deleted"
    checkpoint(cfg, state, oid, op)


def cleanup(cfg, state, manifest, provider):
    retained = {
        item["operation_id"]
        for collection in manifest["collections"].values()
        for item in collection["files"].values()
    }
    retained_files = {
        item["file_id"]
        for collection in manifest["collections"].values()
        for item in collection["files"].values()
    }
    unresolved = []
    for oid, op in state["operations"].items():
        if oid in retained or op["phase"] == "deleted":
            continue
        if op["phase"] in {"upload_ready", "upload_pending", "attach_pending"}:
            unresolved.append(oid)
            continue
        fid = op["file_id"]
        if fid in retained_files:
            continue
        retire(cfg, state, oid, op, provider)
    return unresolved


def run(cfg, command, *, apply=False, provider=None, remote=None):
    if command not in {"index", "update", "plan", "status"}:
        raise RagError("unknown command")
    if cfg.remote_state:
        from .remote_engine import run_remote

        return run_remote(cfg, command, apply=apply, provider=provider, remote=remote)
    if command in {"plan", "status"} or not apply:
        state = load_state(cfg)
        manifest = manifest_for(cfg, state)
        if command == "status":
            return {
                "mode": "status",
                "network_requests": 0,
                "initialized": state is not None,
                "manifest": manifest,
                "pending_operations": sum(
                    op["phase"] not in {"complete", "deleted"}
                    for op in (state or {}).get("operations", {}).values()
                ),
            }
        return plan(cfg, scan(cfg), manifest)
    with StateLock(cfg.state):
        state = load_state(cfg)
        if state is None and command == "update":
            raise RagError("ownership state missing; use index with a fresh empty vector store")
        snapshots = scan(cfg)
        provider_owned = provider is None
        provider = provider or OpenAIProvider(cfg)
        try:
            if state is None:
                if not all(provider.store_empty(c.vector_store_id) for c in cfg.collections):
                    raise RagError(
                        "initial index requires empty vector stores; restore existing state"
                    )
                state = {"schema_version": 1, "ownership": cfg.ownership, "operations": {}}
                atomic_json(cfg.state / ".initialized", {"schema_version": 1})
                save_state(cfg, state)
                atomic_json(cfg.state / "manifest.json", empty_manifest(cfg))
            before = manifest_for(cfg, state)
            guard_commits(cfg, snapshots, before)
            result = plan(cfg, snapshots, before)
            collections = {}
            for collection in cfg.collections:
                snap = snapshots[collection.name]
                entries = {
                    path: stage_file(cfg, state, collection, snap, file, provider)
                    for path, file in snap.files.items()
                }
                collections[collection.name] = {
                    **collection.binding(),
                    "repository_commit": snap.commit,
                    "processing": cfg.processing,
                    "files": entries,
                }
            rescanned = scan(cfg)
            if any(
                rescanned[name].fingerprint != snap.fingerprint for name, snap in snapshots.items()
            ):
                raise RagError("source changed during ingestion; publication aborted")
            published = before
            if collections != before["collections"]:
                published = {
                    "schema_version": 1,
                    "project_id": cfg.project_id,
                    "publication_id": str(uuid.uuid4()),
                    "generation": before["generation"] + 1,
                    "published_at": datetime.now(timezone.utc).isoformat(),
                    "collections": collections,
                }
                # All IDs already durable in the journal. This is the sole publication commit.
                atomic_json(cfg.state / "manifest.json", published)
            result["mode"] = "applied"
            result.pop("network_requests")
            result["publication_id"] = published["publication_id"]
            try:
                result["unresolved_operations"] = cleanup(cfg, state, published, provider)
            except RagError as exc:
                result["cleanup_pending"] = str(exc)
            return result
        finally:
            if provider_owned:
                provider.close()
