"""Small fixed-origin adapter to the official Files and Vector Stores HTTP APIs."""

import os
import re
import time

import httpx

from .config import RagError
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

    def request(self, method, path, *, missing_ok=False, **kwargs):
        attempts = 3 if method in {"GET", "DELETE"} else 1
        for attempt in range(attempts):
            if method not in {"GET", "HEAD"}:
                self.mutation_guard()
            try:
                response = self.client.request(method, path, **kwargs)
            except httpx.TransportError:
                if attempt + 1 < attempts:
                    self.sleep(2**attempt)
                    continue
                raise RagError("provider transport failed; write outcome may be unknown") from None
            if response.status_code == 404 and missing_ok:
                return None
            if response.status_code in {408, 429, 500, 502, 503, 504} and attempt + 1 < attempts:
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
                raise error(f"provider {label} (HTTP {response.status_code})")
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

    def attachment(self, store, fid):
        store, fid = identifier(store, "vs_"), identifier(fid, "file-")
        return self.json("GET", f"vector_stores/{store}/files/{fid}", missing_ok=True)

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
