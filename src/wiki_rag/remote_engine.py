"""Fresh-runner ingestion using only the remote authority and bounded journal pages."""

import uuid
from datetime import datetime, timezone

from .config import RagError
from .engine import checkpoint, empty_manifest, guard_commits, plan, retire
from .provider import OpenAIProvider
from .remote_batch import operation_id, stage_files
from .remote_state import MANIFEST_LIMIT, AuthorityError, RemoteState, encode
from .selection import scan


class OperationLookup:
    """No history cache. Only the operation currently being staged is retained."""

    def __init__(self, remote):
        self.remote = remote

    def get(self, oid):
        return self.remote.lookup([oid]).get(oid)


def prospective_bounds(cfg, snapshots):
    """Conservative manifest envelope budget before any provider writes."""
    count = sum(len(s.files) for s in snapshots.values())
    if count > 10000 or len(cfg.collections) > 20:
        raise RagError("remote manifest file or collection limit exceeded")
    logical = set()
    for collection in cfg.collections:
        for path in snapshots[collection.name].files:
            key = (collection.repository, path)
            if key in logical:
                raise RagError("duplicate logical source across remote collections")
            logical.add(key)
    manifest = {
        "schema_version": 1,
        "project_id": cfg.project_id,
        "publication_id": "0" * 36,
        "generation": 2**53 - 1,
        "published_at": "2000-01-01T00:00:00.000000+00:00",
        "collections": {},
    }
    for collection in cfg.collections:
        snap = snapshots[collection.name]
        manifest["collections"][collection.name] = {
            **collection.binding(),
            "repository_commit": snap.commit,
            "processing": cfg.processing,
            "files": {
                path: {
                    "file_id": "file-" + "x" * 160,
                    "vector_store_id": collection.vector_store_id,
                    "path": path,
                    "sha256": file.sha256,
                    "version": file.version,
                    "kind": file.kind,
                    "source_commit": file.source_commit,
                    "preprocessing": file.preprocessing,
                    "operation_id": "0" * 64,
                }
                for path, file in snap.files.items()
            },
        }
    if len(encode(manifest)) > MANIFEST_LIMIT:
        raise RagError("prospective remote manifest exceeds safe size budget")


def cleanup_remote(cfg, state, provider, keep=()):
    remote = state["_remote"]
    unresolved = 0
    for page in remote.cleanup_pages():
        for item in page:
            oid, op = item["id"], item["operation"]
            if oid in keep:
                continue
            if op["phase"] == "upload_ready":
                # No external intent was dispatched. Keep ownership; protocol v1
                # has no tombstone transition for an unuploaded ready operation.
                unresolved += 1
                continue
            if op["phase"] == "upload_pending":
                op["file_id"] = provider.reconcile_upload(op["filename"], op["sha256"])
                op["phase"] = "uploaded"
                checkpoint(cfg, state, oid, op)
            if op["phase"] == "attach_pending":
                attachment = provider.attachment(op["store"], op["file_id"])
                if not attachment or attachment.get("attributes", {}).get("operation_id") != oid:
                    raise RagError("unresolved obsolete attachment outcome; rerun reconciliation")
                op["phase"] = "attached"
                checkpoint(cfg, state, oid, op)
            retire(cfg, state, oid, op, provider)
    if unresolved:
        raise RagError(
            f"{unresolved} obsolete upload_ready ownership intents retained; "
            "operator review required"
        )


def run_remote(cfg, command, *, apply=False, provider=None, remote=None):
    owned = remote is None
    remote = remote or RemoteState(cfg)
    published = None
    provider_owned = False
    prior_guard = None
    try:
        if command in {"plan", "status"} or not apply:
            status = remote.status()
            manifest = remote.publication() or empty_manifest(cfg)
            if command == "status":
                return {
                    "mode": "status",
                    "network_requests": remote.network_requests,
                    "initialized": status["initialized"],
                    "manifest": manifest,
                    "operation_count": status["operation_count"],
                    **({"job": status["job"]} if status.get("job") else {}),
                }
            result = plan(cfg, scan(cfg), manifest)
            result["network_requests"] = remote.network_requests
            return result
        remote.acquire()
        status = remote.load()
        features = status.get("features", [])
        if not isinstance(features, list) or "async-submit-v1" not in features:
            raise RagError("remote authority requires async-submit-v1 before uploading")
        if command == "update" and not status["initialized"]:
            raise RagError("remote authority uninitialized; use index with fresh empty stores")
        before = remote.publication() or empty_manifest(cfg)
        snapshots = scan(cfg)
        prospective_bounds(cfg, snapshots)
        guard_commits(cfg, snapshots, before)
        provider_owned = provider is None
        provider = provider or OpenAIProvider(cfg)
        prior_guard = getattr(provider, "mutation_guard", None)
        provider.mutation_guard = remote.guard
        if not status["initialized"]:
            if not all(provider.store_empty(c.vector_store_id) for c in cfg.collections):
                raise RagError(
                    "initial remote index requires fresh empty vector stores; no legacy adoption"
                )
            remote.command("initialize")
        state = {"_remote": remote, "operations": OperationLookup(remote)}
        result = plan(cfg, snapshots, before)
        selected = []
        keep = set()
        for collection in cfg.collections:
            previous = before["collections"].get(collection.name, {}).get("files", {})
            for path, file in snapshots[collection.name].files.items():
                keep.add(operation_id(cfg, collection, file))
                if path not in previous or previous[path]["version"] != file.version:
                    selected.append((collection, file))
        staged = stage_files(cfg, state, selected, provider)
        collections = {}
        for collection in cfg.collections:
            snap = snapshots[collection.name]
            previous = before["collections"].get(collection.name, {}).get("files", {})
            entries = {
                path: staged.get((collection.name, path), previous.get(path)) for path in snap.files
            }
            collections[collection.name] = {
                **collection.binding(),
                "repository_commit": snap.commit,
                "processing": cfg.processing,
                "files": entries,
            }
        cleanup_remote(cfg, state, provider, keep)
        rescanned = scan(cfg)
        if any(rescanned[name].fingerprint != snap.fingerprint for name, snap in snapshots.items()):
            raise RagError("source changed during ingestion; publication aborted")
        manifest = before
        if collections != before["collections"]:
            manifest = {
                "schema_version": 1,
                "project_id": cfg.project_id,
                "publication_id": str(uuid.uuid4()),
                "generation": before["generation"] + 1,
                "published_at": datetime.now(timezone.utc).isoformat(),
                "collections": collections,
            }
        manifest_text = encode(manifest)
        if len(manifest_text) > MANIFEST_LIMIT:
            raise RagError("remote manifest exceeds protocol size bound")
        if collections == before["collections"]:
            result.update(
                mode="applied", publication_id=before["publication_id"], unresolved_operations=[]
            )
        else:
            submitted = remote.command("submit", manifestText=manifest_text.decode())
            job_id = submitted.get("job_id")
            try:
                if str(uuid.UUID(job_id)) != job_id:
                    raise ValueError()
            except ValueError, TypeError, AttributeError:
                raise AuthorityError("invalid authority submission receipt") from None
            result.update(mode="submitted", job_id=job_id, unresolved_operations=[])
        remote.guard()
        result.pop("network_requests")
        return result
    except RagError as exc:
        published = published or remote.committed_publication
        if published:
            raise RagError(
                f"publication committed ({published}); cleanup incomplete: {exc}"
            ) from None
        raise
    finally:
        if provider is not None:
            if prior_guard is not None:
                provider.mutation_guard = prior_guard
            if provider_owned:
                provider.close()
        if owned:
            # Release failures remain fatal, including after committed publication.
            import sys

            try:
                remote.finish(suppress=sys.exc_info()[0] is not None)
            except AuthorityError as exc:
                if published:
                    raise RagError(
                        f"publication committed ({published}); lease release failed: {exc}"
                    ) from None
                raise
