"""Concurrent uploads and batched attachment submission; journal writes stay serial."""

import json
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor

from .config import RagError
from .engine import retire
from .provider import RejectedWrite
from .remote_state import encode
from .selection import stable_hash

UPLOAD_WORKERS = 8
ATTACH_BATCH = 500


def operation_id(cfg, collection, file):
    return stable_hash(
        [
            cfg.project_id,
            collection.name,
            collection.repository,
            collection.branch,
            file.path,
            file.version,
        ]
    )


def attributes(collection, file, oid, op):
    return {
        "repository": collection.repository,
        "path": file.path,
        "commit": op["source_commit"] or "working-tree",
        "kind": file.kind,
        "collection": collection.name,
        "branch": collection.branch or "unspecified",
        "sha256": file.sha256,
        "operation_id": oid,
        **({"source_kind": op["origin"]["kind"]} if op.get("origin") else {}),
    }


def stage_files(cfg, state, selected, provider):
    """Stage selected (collection, file) pairs without waiting for vector indexing."""
    remote = state["_remote"]
    rows = [(operation_id(cfg, c, f), c, f) for c, f in selected]
    ops = {}
    for offset in range(0, len(rows), 50):
        ops.update(remote.lookup([r[0] for r in rows[offset : offset + 50]]))

    def checkpoint(ids, retired=()):
        remote.checkpoint_many([{"id": oid, "operation": ops[oid]} for oid in ids], retired)

    # Prepare only the current dispatch window. Future sources have no upload intent.
    with ThreadPoolExecutor(
        max_workers=UPLOAD_WORKERS, thread_name_prefix="wiki-rag-upload"
    ) as pool:
        for offset in range(0, len(rows), UPLOAD_WORKERS):
            window = rows[offset : offset + UPLOAD_WORKERS]
            ready, pending, new, retired = [], [], [], []
            for oid, collection, file in window:
                op = ops.get(oid)
                attempts = 1
                if op and op.get("terminal_failure"):
                    print(
                        "wiki-rag: "
                        + json.dumps(
                            {
                                "event": "terminal_recovery_candidate",
                                "operation_id": oid,
                                "source_bytes": len(file.content),
                                "ingestion_attempts": op.get("ingestion_attempts", 1),
                            }
                        ),
                        file=sys.stderr,
                    )
                    attempts = op.get("ingestion_attempts", 1) + 1
                    if attempts > 3:
                        raise RagError(
                            "terminal ingestion retry limit reached; "
                            "operator investigation required"
                        )
                if op and op["phase"] in {
                    "ingestion_failed",
                    "detach_pending",
                    "detached",
                    "file_delete_pending",
                    "deleted",
                }:
                    retire(cfg, state, oid, op, provider)
                    retired.append({"id": oid, "retired_id": f"{oid}.retired.{uuid.uuid4().hex}"})
                    op = None
                if op is None:
                    op = {
                        "filename": f"wiki-rag-{uuid.uuid4().hex}"
                        + (".pdf" if file.kind == "pdf" else ".txt"),
                        "phase": "upload_ready",
                        "store": collection.vector_store_id,
                        "collection": collection.name,
                        "sha256": file.sha256,
                        "path": file.path,
                        "version": file.version,
                        "source_commit": file.source_commit,
                        "ingestion_attempts": attempts,
                        **({"origin": file.origin} if file.origin else {}),
                    }
                    ops[oid] = op
                    new.append(oid)
                if op["phase"] == "upload_ready":
                    ready.append((oid, file))
                elif op["phase"] == "upload_pending":
                    pending.append(oid)
            if new:
                checkpoint(new, retired)
            # Reconcile old unknown creates before dispatching any new ones.
            for oid in pending:
                op = ops[oid]
                op["file_id"] = provider.reconcile_upload(op["filename"], op["sha256"])
                op["phase"] = "uploaded"
                checkpoint([oid])
            for oid, _ in ready:
                ops[oid]["phase"] = "upload_pending"
            if ready:
                checkpoint([oid for oid, _ in ready])
            futures = []
            dispatch_error = None
            for oid, file in ready:
                try:
                    remote.guard()
                    futures.append(
                        (oid, pool.submit(provider.upload, ops[oid]["filename"], file.content))
                    )
                except BaseException as exc:
                    dispatch_error = exc
                    break
            # Always drain; ordinary failures do not discard other successful receipts.
            errors, receipts = [], []
            for oid, future in futures:
                try:
                    ops[oid]["file_id"] = future.result()
                    ops[oid]["phase"] = "uploaded"
                    receipts.append(oid)
                except RejectedWrite as exc:
                    ops[oid]["phase"] = "upload_ready"
                    receipts.append(oid)
                    errors.append(exc)
                except BaseException as exc:
                    errors.append(exc)
            remote.guard()  # Never checkpoint after authority loss, even a successful upload.
            if receipts:
                checkpoint(receipts)
                print(
                    f"wiki-rag: upload window recorded ({offset + len(window)}/{len(rows)})",
                    file=sys.stderr,
                )
            if dispatch_error:
                raise dispatch_error
            if errors:
                raise errors[0]

    stores = {}
    for oid, collection, file in rows:
        stores.setdefault(collection.vector_store_id, []).append((oid, collection, file))
    for store, group in stores.items():
        uncertain = [(oid, c, f) for oid, c, f in group if ops[oid]["phase"] == "attach_pending"]
        if uncertain:
            found = provider.attachments_by_id(
                store, {ops[oid]["file_id"] for oid, _, _ in uncertain}
            )
            print(
                f"wiki-rag: reconciling attachments (pending={len(uncertain)}, found={len(found)})",
                file=sys.stderr,
            )
            confirmed = []
            for oid, c, f in uncertain:
                attached = found.get(ops[oid]["file_id"])
                reason = None
                expected = attributes(c, f, oid, ops[oid])
                repair = getattr(provider, "restore_owned_attributes", None)
                if (
                    repair is not None
                    and attached
                    and attached.get("attributes") == {}
                    and attached.get("id") == ops[oid]["file_id"]
                    and attached.get("vector_store_id") == store
                ):
                    remote.guard()
                    attached = repair(
                        store,
                        ops[oid]["file_id"],
                        filename=ops[oid]["filename"],
                        sha=ops[oid]["sha256"],
                        content=f.content,
                        attributes=expected,
                        chunking=cfg.processing["chunking"],
                    )
                    found[ops[oid]["file_id"]] = attached
                    print(
                        "wiki-rag: reconciled empty attributes for an owned attachment",
                        file=sys.stderr,
                    )
                if not attached:
                    reason = "missing attachment"
                elif attached.get("id") != ops[oid]["file_id"]:
                    reason = "id mismatch"
                elif attached.get("attributes") != expected:
                    actual = attached.get("attributes")
                    field = next(
                        (
                            k
                            for k, v in expected.items()
                            if not isinstance(actual, dict) or actual.get(k) != v
                        ),
                        "keys",
                    )
                    issue = (
                        "missing"
                        if field in expected
                        and (not isinstance(actual, dict) or field not in actual)
                        else "mismatch"
                    )
                    reason = f"attributes.{field} {issue}"
                elif attached.get("status") not in {
                    "in_progress",
                    "completed",
                    "failed",
                    "cancelled",
                }:
                    reason = "status invalid"
                elif attached.get("vector_store_id", store) != store:
                    reason = "vector_store_id mismatch"
                if reason:
                    empty_attributes = sum(item.get("attributes") == {} for item in found.values())
                    raise RagError(
                        f"unresolved attachment outcome: {len(found)}/{len(uncertain)} found; "
                        f"{empty_attributes} empty attribute records; {reason}; "
                        "retry reconciliation later"
                    )
                ops[oid]["phase"] = "attached"
                confirmed.append(oid)
            checkpoint(confirmed)
            print(
                f"wiki-rag: reconciled attachment receipts ({len(confirmed)} files)",
                file=sys.stderr,
            )
        batches, batch = [], []
        for oid, c, f in group:
            if ops[oid]["phase"] != "uploaded":
                continue
            item = {"file_id": ops[oid]["file_id"], "attributes": attributes(c, f, oid, ops[oid])}
            candidate = batch + [(oid, item)]
            # Leave ample room for provider metadata and per-file chunking.
            if len(candidate) > ATTACH_BATCH or len(encode(candidate)) > 2 * 1024 * 1024:
                batches.append(batch)
                batch = [(oid, item)]
            else:
                batch = candidate
        if batch:
            batches.append(batch)
        for batch in batches:
            ids = [oid for oid, _ in batch]
            for oid in ids:
                ops[oid]["phase"] = "attach_pending"
            checkpoint(ids)
            try:
                remote.guard()
                provider.attach_batch(
                    store, [item for _, item in batch], cfg.processing["chunking"]
                )
            except RejectedWrite:
                for oid in ids:
                    ops[oid]["phase"] = "uploaded"
                checkpoint(ids)
                raise
            for oid in ids:
                ops[oid]["phase"] = "attached"
            checkpoint(ids)
            print(f"wiki-rag: submitted attachment batch ({len(batch)} files)", file=sys.stderr)
    entries = {}
    for oid, collection, file in rows:
        op = ops[oid]
        if op["phase"] not in {"attached", "complete"}:
            raise RagError("operation is not ready for background indexing")
        entries[collection.name, file.path] = {
            "file_id": op["file_id"],
            "vector_store_id": op["store"],
            "path": file.path,
            "sha256": file.sha256,
            "version": file.version,
            "kind": file.kind,
            "source_commit": op["source_commit"],
            "preprocessing": file.preprocessing,
            "operation_id": oid,
            **({"origin": op["origin"]} if op.get("origin") else {}),
        }
    return entries
