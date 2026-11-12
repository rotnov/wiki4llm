"""Small fixed-origin adapter to the official Files and Vector Stores HTTP APIs."""

import json
import os
import re
import sys
import time

import httpx

from .config import RagError
from .provider_diagnostics import (
    CODES,
    attribute_values,
    error_details,
    route_shape,
    sanitized_message,
)
from .selection import digest


class RejectedWrite(RagError):
    """The provider explicitly rejected a create before accepting a resource."""


class TerminalIngestionFailure(RagError):
    """A provider-confirmed failed/cancelled ingestion, distinct from unknown outcomes."""

    def __init__(self, status):
        if status not in {"failed", "cancelled"}:
            raise ValueError("terminal status required")
        self.status = status
        super().__init__(f"ingestion {status}; rerun to attempt bounded recovery")


def identifier(value, prefix):
    if not isinstance(value, str) or not re.fullmatch(prefix + r"[A-Za-z0-9_-]+", value):
        raise RagError("invalid provider resource identifier")
    return value


class OpenAIProvider:
    def __init__(self, cfg, *, transport=None, sleep=time.sleep):
        key = os.environ.get(cfg.api_key_env)
        if not key or "\n" in key or "\r" in key:
            raise RagError("configured API key environment variable is missing or invalid")
        self.sleep = sleep
        self._diagnostic_secrets = (key, cfg.project_id)
        self.mutation_guard = lambda: None
        self.client = httpx.Client(
            base_url="https://api.openai.com/v1/",
            timeout=30,
            follow_redirects=False,
            trust_env=False,
            transport=transport,
            headers={
                "Authorization": "Bearer " + key,
                "OpenAI-Project": cfg.project_id,
                "OpenAI-Beta": "assistants=v2",
                "User-Agent": "wiki-rag/0.1.0",
            },
        )

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def close(self):
        self.client.close()

    def request(
        self, method, path, *, missing_ok=False, retry_rate_limit=False, stage=None, **kwargs
    ):
        safe_replay = method in {"GET", "DELETE"}
        attempts = 3 if safe_replay or retry_rate_limit else 1
        route = route_shape(path)
        context = {"stage": stage or route, "method": method, "route": route}
        payload = kwargs.get("json")
        if isinstance(payload, dict) and isinstance(payload.get("files"), list):
            context["batch_size"] = len(payload["files"])
        sensitive = [*self._diagnostic_secrets, *attribute_values(payload)]

        def emit(event, **details):
            print(
                "wiki-rag: " + json.dumps({"event": event, **context, **details}), file=sys.stderr
            )

        for attempt in range(attempts):
            if method not in {"GET", "HEAD"}:
                self.mutation_guard()
            if "batch_size" in context or stage == "recover_attachment_metadata":
                emit("provider_request_started", attempt=attempt + 1)
            started = time.monotonic()
            try:
                response = self.client.request(method, path, **kwargs)
            except httpx.TransportError:
                emit(
                    "provider_transport_failed",
                    attempt=attempt + 1,
                    elapsed_ms=round((time.monotonic() - started) * 1000),
                    retrying=safe_replay and attempt + 1 < attempts,
                )
                if safe_replay and attempt + 1 < attempts:
                    self.sleep(2**attempt)
                    continue
                raise RagError(
                    f"provider transport failed ({method} {route}); write outcome may be unknown"
                ) from None
            timing = {
                "attempt": attempt + 1,
                "elapsed_ms": round((time.monotonic() - started) * 1000),
                "status": response.status_code,
            }
            request_id = response.headers.get("x-request-id", "")
            if re.fullmatch(r"req_[A-Za-z0-9_-]{1,150}", request_id):
                timing["request_id"] = request_id
            diagnostic = error_details(response, sensitive=sensitive) if response.is_error else {}
            if response.is_error:
                emit("provider_request_failed", **timing, **diagnostic)
            elif "batch_size" in context or stage == "recover_attachment_metadata":
                emit("provider_request_completed", **timing)
            if response.status_code == 404 and missing_ok:
                return None
            if response.status_code == 429 and retry_rate_limit and attempt + 1 < attempts:
                delay = response.headers.get("Retry-After", "60")
                delay = max(1, min(60, int(delay))) if delay.isdecimal() else 60
                emit("provider_retry_scheduled", attempt=attempt + 1, delay_seconds=delay)
                self.sleep(delay)
                continue
            if (
                safe_replay
                and response.status_code in {408, 429, 500, 502, 503, 504}
                and attempt + 1 < attempts
            ):
                self.sleep(2**attempt)
                continue
            if not 200 <= response.status_code < 300:
                error = (
                    RejectedWrite
                    if method == "POST"
                    and response.status_code in {400, 401, 403, 404, 413, 422, 429}
                    else RagError
                )
                label = (
                    "permission denied" if response.status_code in {401, 403} else "request failed"
                )
                suffix = "; " + json.dumps({**context, **timing, **diagnostic})
                raise error(
                    f"provider {label} (HTTP {response.status_code}; {method} {route}{suffix})"
                )
            return response
        raise RagError("provider retry limit reached")

    def json(self, method, path, **kwargs):
        response = self.request(method, path, **kwargs)
        if response is None:
            return None
        try:
            data = response.json()
            if not isinstance(data, dict):
                raise ValueError()
            return data
        except ValueError:
            raise RagError("invalid provider JSON response; write outcome may be unknown") from None

    def store_empty(self, store):
        store = identifier(store, "vs_")
        data = self.json("GET", f"vector_stores/{store}/files", params={"limit": 1})
        if not isinstance(data.get("data"), list):
            raise RagError("invalid provider file list")
        return not data["data"] and data.get("has_more") is False

    def attachment_failures(self, store, *, sensitive=()):
        """GET-only terminal failure receipt; store presence is not ownership proof."""
        store = identifier(store, "vs_")
        failures, seen, after, scanned = [], set(), None, 0
        for _ in range(1000):
            params = {"limit": 100, "order": "asc"}
            if after:
                params["after"] = after
            response = self.request("GET", f"vector_stores/{store}/files", params=params)
            if len(response.content) > 2_000_000:
                raise RagError("provider diagnosis page exceeds size limit")
            try:
                page = response.json()
            except ValueError:
                raise RagError("invalid provider diagnosis JSON") from None
            if (
                not isinstance(page, dict)
                or not isinstance(page.get("data"), list)
                or len(page["data"]) > 100
                or type(page.get("has_more")) is not bool
            ):
                raise RagError("invalid provider diagnosis page")
            last = None
            for item in page["data"]:
                if not isinstance(item, dict):
                    raise RagError("invalid provider diagnosis record")
                fid = identifier(item.get("id"), "file-")
                status = item.get("status")
                if (
                    len(fid) > 200
                    or fid in seen
                    or status not in ("in_progress", "completed", "failed", "cancelled")
                ):
                    raise RagError("invalid or repeated provider diagnosis record")
                seen.add(fid)
                last = fid
                scanned += 1
                if status not in ("failed", "cancelled"):
                    continue
                attrs, usage = item.get("attributes"), item.get("usage_bytes")
                error = item.get("last_error") or {}
                if (
                    (attrs is not None and not isinstance(attrs, dict))
                    or type(usage) is not int
                    or usage < 0
                    or not isinstance(error, dict)
                ):
                    raise RagError("invalid provider diagnosis failure")
                code = error.get("code")
                failures.append(
                    {
                        "file_id": fid,
                        "status": status,
                        "metadata_state": "absent"
                        if attrs is None
                        else "present"
                        if attrs
                        else "empty",
                        "usage_bytes": usage,
                        "last_error": {
                            "code": code
                            if isinstance(code, str)
                            and code in CODES | {"invalid_file", "unsupported_file"}
                            else "unknown",
                            "message": sanitized_message(
                                error.get("message"),
                                [
                                    *self._diagnostic_secrets,
                                    *sensitive,
                                    *attribute_values({"attributes": attrs}),
                                ],
                            ),
                        },
                    }
                )
                if len(failures) > 10000:
                    raise RagError("provider diagnosis failure receipt limit reached")
            if not page["has_more"]:
                return {"scanned_files": scanned, "failures": failures}
            if last is None or page.get("last_id") != last:
                raise RagError("invalid provider diagnosis pagination")
            after = last
        raise RagError("provider diagnosis pagination limit reached")

    def upload(self, filename, content):
        data = self.json(
            "POST",
            "files",
            data={"purpose": "assistants"},
            files={
                "file": (
                    filename,
                    content,
                    "application/pdf" if filename.endswith(".pdf") else "text/plain; charset=utf-8",
                )
            },
        )
        return identifier(data.get("id"), "file-")

    def reconcile_upload(self, filename, sha):
        matches, seen, after = [], set(), None
        for _ in range(1000):
            params = {"purpose": "assistants", "limit": 100, "order": "asc"}
            if after:
                params["after"] = after
            data = self.json("GET", "files", params=params)
            if not isinstance(data.get("data"), list) or type(data.get("has_more")) is not bool:
                raise RagError("invalid provider file list")
            for item in data["data"]:
                if item.get("filename") == filename:
                    matches.append(identifier(item.get("id"), "file-"))
            if not data["has_more"]:
                break
            after = data.get("last_id")
            if not after or after in seen:
                raise RagError("invalid provider pagination")
            seen.add(after)
        else:
            raise RagError("provider reconciliation pagination limit reached")
        if len(matches) != 1:
            raise RagError(
                "unresolved upload outcome; retry reconciliation later, never recreate blindly"
            )
        fid = matches[0]
        content = self.request("GET", f"files/{fid}/content").content
        if digest(content) != sha:
            raise RagError("reconciled upload content mismatch")
        return fid

    def attach(self, store, fid, attributes, chunking):
        store, fid = identifier(store, "vs_"), identifier(fid, "file-")
        self.json(
            "POST",
            f"vector_stores/{store}/files",
            json={"file_id": fid, "attributes": attributes, "chunking_strategy": chunking},
        )

    def attach_batch(self, store, items, chunking):
        """Submit once; per-file journal intents reconcile an uncertain response."""
        store = identifier(store, "vs_")
        if not 1 <= len(items) <= 2000:
            raise RagError("attachment batch requires 1..2000 files")
        files = []
        for item in items:
            files.append(
                {
                    "file_id": identifier(item["file_id"], "file-"),
                    "attributes": item["attributes"],
                    "chunking_strategy": chunking,
                }
            )
        data = self.json(
            "POST",
            f"vector_stores/{store}/file_batches",
            json={"files": files},
            retry_rate_limit=True,
            stage="attach_batch",
        )
        identifier(data.get("id"), "vsfb_")
        if data.get("status") not in {"in_progress", "completed", "failed", "cancelled"}:
            raise RagError("invalid provider batch response; write outcome may be unknown")
        return data

    def attachments_by_id(self, store, ids):
        """Bounded listing for uncertain attachment reconciliation, never readiness polling."""
        store = identifier(store, "vs_")
        wanted = {identifier(fid, "file-") for fid in ids}
        if not wanted or len(wanted) > 10000:
            raise RagError("invalid attachment reconciliation size")
        found, seen, after = {}, set(), None
        for _ in range(1000):
            params = {"limit": 100, "order": "asc"}
            if after:
                params["after"] = after
            response = self.request("GET", f"vector_stores/{store}/files", params=params)
            if len(response.content) > 2 * 1024 * 1024:
                raise RagError("provider file list exceeds size bound")
            try:
                data = response.json()
            except ValueError:
                raise RagError("invalid provider file list") from None
            if (
                not isinstance(data, dict)
                or not isinstance(data.get("data"), list)
                or len(data["data"]) > 100
                or type(data.get("has_more")) is not bool
            ):
                raise RagError("invalid provider file list")
            for item in data["data"]:
                if not isinstance(item, dict):
                    raise RagError("invalid provider attachment")
                fid = identifier(item.get("id"), "file-")
                if fid in wanted:
                    if fid in found or not isinstance(item.get("attributes"), dict):
                        raise RagError("invalid provider attachment")
                    found[fid] = item
            if not data["has_more"] or wanted == found.keys():
                return found
            after = data.get("last_id")
            if (
                not data["data"]
                or not after
                or after in seen
                or after != data["data"][-1].get("id")
            ):
                raise RagError("invalid provider pagination")
            identifier(after, "file-")
            seen.add(after)
        raise RagError("provider reconciliation pagination limit reached")

    def attachment(self, store, fid):
        store, fid = identifier(store, "vs_"), identifier(fid, "file-")
        return self.json("GET", f"vector_stores/{store}/files/{fid}", missing_ok=True)

    def restore_owned_attributes(self, store, fid, *, filename, sha, content, attributes, chunking):
        """Finish empty metadata for a durably acknowledged upload, never adopt a file."""
        store, fid = identifier(store, "vs_"), identifier(fid, "file-")
        if (
            digest(content) != sha
            or attributes.get("sha256") != sha
            or not attributes.get("operation_id")
        ):
            raise RagError("attachment recovery source does not match its upload receipt")

        def inspect():
            item = self.json(
                "GET",
                f"vector_stores/{store}/files/{fid}",
                missing_ok=True,
                stage="recover_attachment_inspect",
            )
            if not item or item.get("id") != fid or item.get("vector_store_id") != store:
                raise RagError("attachment recovery identity mismatch")
            if item.get("status") not in {"in_progress", "completed", "failed", "cancelled"}:
                raise RagError("attachment recovery status invalid")
            if item.get("attributes") == attributes:
                return item
            if item.get("attributes") != {}:
                raise RagError("attachment recovery refuses nonempty or unknown attributes")
            if item["status"] not in {"in_progress", "completed"}:
                raise RagError(
                    f"attachment recovery cannot repair empty metadata on a {item['status']} file"
                )
            if item.get("chunking_strategy") != chunking:
                raise RagError("attachment recovery chunking mismatch")
            return item

        current = inspect()
        if current["attributes"] == attributes:
            return current
        uploaded = self.json("GET", f"files/{fid}", stage="recover_upload_inspect")
        if (
            uploaded.get("id") != fid
            or uploaded.get("filename") != filename
            or uploaded.get("purpose") != "assistants"
            or type(uploaded.get("bytes")) is not int
            or uploaded["bytes"] != len(content)
        ):
            raise RagError("attachment recovery file does not match its acknowledged upload")
        # The File ID and source hash were persisted after a successful upload.
        # Recheck mutable attachment attributes after inspecting that immutable File.
        current = inspect()
        if current["attributes"] == attributes:
            return current
        print(
            "wiki-rag: "
            + json.dumps(
                {"event": "metadata_recovery_candidate", "attachment_status": current["status"]}
            ),
            file=sys.stderr,
        )
        self.request(
            "POST",
            f"vector_stores/{store}/files/{fid}",
            json={"attributes": attributes},
            stage="recover_attachment_metadata",
        )
        current = inspect()
        if current["attributes"] != attributes:
            raise RagError("attachment metadata recovery readback failed")
        return current

    def wait_completed(self, store, fid):
        for _ in range(60):
            obj = self.attachment(store, fid)
            status = obj.get("status") if obj else None
            if status == "completed":
                return
            if status in {"failed", "cancelled"}:
                raise TerminalIngestionFailure(status)
            if status not in {"in_progress"}:
                raise RagError(
                    "ingestion failed, cancelled, missing or invalid; publication preserved"
                )
            self.sleep(2)
        raise RagError("ingestion polling limit reached; rerun to resume")

    def delete_attachment(self, store, fid):
        store, fid = identifier(store, "vs_"), identifier(fid, "file-")
        self.request("DELETE", f"vector_stores/{store}/files/{fid}", missing_ok=True)

    def delete_file(self, fid):
        fid = identifier(fid, "file-")
        self.request("DELETE", f"files/{fid}", missing_ok=True)
