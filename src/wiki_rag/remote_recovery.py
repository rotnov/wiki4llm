"""Prove selected terminal failures before marking or retiring any owned upload."""

import json
import re
import sys

from .config import RagError
from .provider import identifier
from .selection import digest

RETIRING = {"detach_pending", "detached", "file_delete_pending", "deleted"}


def emit(event, **fields):
    print("wiki-rag: " + json.dumps({"event": event, **fields}), file=sys.stderr, flush=True)


def owned_receipt(collection, file, op):
    """The acknowledged receipt binds selected source bytes to an immutable File ID."""
    if (
        op.get("store") != collection.vector_store_id
        or op.get("collection") != collection.name
        or op.get("sha256") != file.sha256
        or digest(file.content) != file.sha256
        or op.get("version") != file.version
        or op.get("path") != file.path
        or op.get("origin") != file.origin
        or not re.fullmatch(
            r"wiki-rag-[0-9a-f]{32}" + (r"\.pdf" if file.kind == "pdf" else r"\.txt"),
            op.get("filename", ""),
        )
    ):
        raise RagError("terminal recovery source does not match its acknowledged upload")
    identifier(op.get("file_id"), "file-")
    attempts = op.get("ingestion_attempts", 1)
    if type(attempts) is not int or not 1 <= attempts <= 3:
        raise RagError("invalid terminal ingestion attempt receipt")


def inspect_failure(provider, file, op, expected, chunking):
    store, fid = op["store"], op["file_id"]

    def inspect():
        item = provider.attachment(store, fid)
        if (
            not isinstance(item, dict)
            or item.get("id") != fid
            or item.get("vector_store_id") != store
            or item.get("status") not in {"failed", "cancelled"}
            or item.get("attributes") not in (None, {}, expected)
            or item.get("chunking_strategy") != chunking
            or not isinstance(item.get("last_error"), dict)
            or item["last_error"].get("code") != "server_error"
        ):
            raise RagError(
                "terminal recovery attachment is not eligible; preserve for investigation"
            )
        return item

    inspect()
    uploaded = provider.json("GET", f"files/{fid}", stage="terminal_upload_inspect")
    if (
        not isinstance(uploaded, dict)
        or uploaded.get("id") != fid
        or uploaded.get("filename") != op["filename"]
        or uploaded.get("purpose") != "assistants"
        or type(uploaded.get("bytes")) is not int
        or uploaded["bytes"] != len(file.content)
    ):
        raise RagError("terminal recovery File does not match its acknowledged upload")
    # External provider edits are not fenced by the authority lease. Re-read the
    # mutable attachment after immutable File inspection; GET+DELETE is not atomic.
    inspect()


def prove_terminal_recovery(cfg, remote, rows, ops, provider, attributes):
    if not any(
        op["phase"] == "ingestion_failed"
        or (op["phase"] in RETIRING and op.get("terminal_failure"))
        for op in ops.values()
    ):
        return set()

    failures, scanned = {}, 0
    sensitive = getattr(provider, "diagnostic_sensitive", ())
    # Stream each bounded sanitized receipt before any recovery checkpoint. A
    # malformed later page/store preserves earlier logs, but cannot authorize work.
    for collection in cfg.collections:
        remote.guard()

        def observed(failure):
            if len(failures) >= 10000:
                raise RagError("provider diagnosis failure receipt limit reached")
            key = (collection.vector_store_id, failure["file_id"])
            if key in failures:
                raise RagError("duplicate terminal diagnostic identity")
            failures[key] = failure
            emit("terminal_diagnostic_failure", collection=collection.name, **failure)

        receipt = provider.attachment_failures(
            collection.vector_store_id, sensitive=sensitive, on_failure=observed
        )
        scanned += receipt["scanned_files"]
    emit("terminal_diagnostic_scan_complete", scanned_files=scanned, failures=len(failures))

    eligible, markers, identities = set(), [], set()
    for oid, collection, file in rows:
        op = ops.get(oid)
        if not op:
            continue
        phase = op["phase"]
        key = (op.get("store"), op.get("file_id"))
        interrupted = phase in RETIRING and op.get("terminal_failure")
        if not (
            interrupted or phase == "ingestion_failed" or (phase == "attached" and key in failures)
        ):
            continue
        owned_receipt(collection, file, op)
        if key in identities:
            raise RagError("ambiguous terminal recovery ownership")
        identities.add(key)
        emit(
            "terminal_recovery_candidate",
            operation_id=oid,
            source_bytes=len(file.content),
            ingestion_attempts=op.get("ingestion_attempts", 1),
        )
        if op.get("ingestion_attempts", 1) >= 3:
            raise RagError(
                "terminal ingestion retry limit reached; operator investigation required"
            )
        if interrupted:
            # The exact durable deletion intent survives detach/delete. It cannot
            # obtain fresh terminal proof or be assigned a fresh attempt here.
            continue
        if key not in failures or failures[key]["last_error"]["code"] != "server_error":
            raise RagError("terminal recovery lacks a current server_error receipt")
        remote.guard()
        inspect_failure(
            provider,
            file,
            op,
            attributes(collection, file, oid, op),
            cfg.processing["chunking"],
        )
        eligible.add(oid)
        if phase != "ingestion_failed" or op.get("terminal_failure") is not True:
            markers.append(
                {"id": oid, "operation": dict(op, phase="ingestion_failed", terminal_failure=True)}
            )

    # checkpoint_many enforces <=100 entries and byte bounds. Earlier batches may
    # survive a later failure; no deletion starts until ALL succeed. The next run
    # freshly proves every ingestion_failed entry, including those durable markers.
    remote.guard()
    if markers:
        remote.checkpoint_many(markers)
        ops.update((item["id"], item["operation"]) for item in markers)
    return eligible
