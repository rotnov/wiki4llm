"""Aggregate ingestion diagnostics for logs without source-file metadata."""


def summarize(result):
    """Keep configured labels, revisions and counts; never copy path/error records."""
    summary = {
        name: result[name]
        for name in ("mode", "workspace", "publication_id", "job_id", "network_requests")
        if name in result
    }
    if "job" in result:
        summary["job"] = {
            k: v
            for k, v in result["job"].items()
            if k
            in {
                "id",
                "status",
                "total",
                "completed",
                "error",
                "publication_id",
                "created_at",
                "finished_at",
                "duration_ms",
            }
        }
    summary["collections"] = {}
    for name, collection in result.get("collections", {}).items():
        changes = collection["changes"]
        summary["collections"][name] = {
            "selected_files": collection["selected_files"],
            "selected_bytes": collection["selected_bytes"],
            "repository_commit": collection["repository_commit"],
            "changed_files": len(changes),
            "changes": {
                action: sum(change["action"] == action for change in changes)
                for action in ("add", "replace", "delete")
            },
            "skipped_files": len(collection["skipped"]),
        }
    if "cleanup_pending" in result:
        summary["cleanup_pending"] = True
    if "unresolved_operations" in result:
        summary["unresolved_operations"] = len(result["unresolved_operations"])
    return summary
