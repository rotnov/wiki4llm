"""Protocol-v1 authority transport, fenced lease and bounded operation access."""

import hashlib
import json
import os
import random
import re
import secrets
import threading
import time
import uuid
from urllib.parse import urlsplit

import httpx

from .config import RagError

SMALL_LIMIT = 512 * 1024
MANIFEST_LIMIT = 8 * 1024 * 1024
SNAPSHOT_LIMIT = 9 * 1024 * 1024
SAFE_INTEGER = 2**53 - 1


class AuthorityError(RagError):
    """Fatal authority/lease uncertainty; never downgrade to successful cleanup."""


class HTTPFailure(AuthorityError):
    def __init__(self, status, retry_after=1):
        self.status = status
        self.retry_after = retry_after
        super().__init__(
            f"remote authority request failed (HTTP {status}); rerun with fresh source"
        )


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()


def number(value, minimum=0):
    if type(value) is not int or not minimum <= value <= SAFE_INTEGER:
        raise AuthorityError("invalid authority integer")
    return value


def validate_job_diagnostics(value):
    """Accept only bounded machine diagnostics, never provider prose or source metadata."""
    required = {"stage", "operation_id", "attachment_status", "metadata_state"}
    optional = {"metadata_field", "provider_error_code", "usage_bytes"}
    enums = {
        "stage": {"finalize_attachment"},
        "attachment_status": {"in_progress", "completed", "failed", "cancelled"},
        "metadata_state": {"matching", "absent", "empty", "missing", "conflict"},
        "metadata_field": {
            "repository",
            "path",
            "commit",
            "kind",
            "collection",
            "branch",
            "sha256",
            "operation_id",
            "source_kind",
        },
        "provider_error_code": {"server_error", "unsupported_file", "invalid_file", "unrecognized"},
    }
    if (
        not isinstance(value, dict)
        or not required <= value.keys() <= required | optional
        or any(
            not isinstance(value[k], str) or value[k] not in choices
            for k, choices in enums.items()
            if k in value
        )
        or not isinstance(value["operation_id"], str)
        or not re.fullmatch(r"[a-f0-9]{64}", value["operation_id"])
        or (
            "usage_bytes" in value
            and (
                type(value["usage_bytes"]) is not int
                or not 0 <= value["usage_bytes"] <= SAFE_INTEGER
            )
        )
    ):
        raise AuthorityError("invalid authority job diagnostics")
    return value


def decode(data):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError()
            value[key] = item
        return value

    try:
        return json.loads(data, object_pairs_hook=unique, parse_constant=lambda _: None)
    except ValueError, UnicodeError:
        raise AuthorityError("invalid authority JSON response") from None


class RemoteState:
    """One attempt. Journal revisions are main-thread-owned; heartbeat only renews lease."""

    def __init__(self, cfg, *, transport=None, monotonic=time.monotonic, heartbeat_seconds=30):
        self.cfg = cfg
        config = cfg.remote_state
        origin = os.environ.get(config.origin_env, "")
        try:
            parsed = urlsplit(origin)
            valid = (
                parsed.scheme == "https"
                and parsed.hostname
                and not parsed.username
                and not parsed.password
                and not parsed.path
                and not parsed.query
                and not parsed.fragment
                and parsed.port in {None, 443}
                and origin == "https://" + parsed.netloc
                and not any(c.isspace() for c in origin)
                and "\\" not in origin
            )
        except ValueError:
            valid = False
        if not valid:
            raise RagError(
                "remote origin must be an exact HTTPS origin without path or credentials"
            )
        headers = {}
        for env, name in (
            (config.client_id_env, "CF-Access-Client-Id"),
            (config.client_secret_env, "CF-Access-Client-Secret"),
        ):
            value = os.environ.get(env, "")
            if not value or not value.isascii() or any(ord(c) < 32 or ord(c) == 127 for c in value):
                raise RagError("configured Access environment variable is missing or invalid")
            headers[name] = value
        self.client = httpx.Client(
            base_url=origin + f"/ingest/{config.workspace}/",
            headers=headers,
            timeout=30,
            follow_redirects=False,
            trust_env=False,
            transport=transport,
        )
        self.monotonic = monotonic
        self.heartbeat_seconds = heartbeat_seconds
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.thread = None
        self.epoch = None
        self.nonce = secrets.token_hex(32)
        self.deadline = 0
        self.poisoned = False
        self.revision = 0
        self.network_requests = 0
        self.committed_publication = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.finish(suppress=bool(args[0]))

    def request(self, method, route, body=None, *, limit=SMALL_LIMIT, raw=False, params=None):
        data = encode(body) if body is not None else None
        if data is not None and len(data) > (
            17 * 1024 * 1024 if route in {"publish", "submit"} else SMALL_LIMIT
        ):
            raise AuthorityError("authority request exceeds protocol size bound")
        # Fixed logical body is retained across ambiguous transport retries.
        attempts = 1 if route == "lease" and body and body.get("action") == "renew" else 3
        for attempt in range(attempts):
            self.network_requests += 1
            try:
                with self.client.stream(
                    method,
                    route,
                    content=data,
                    params=params,
                    headers={"Content-Type": "application/json"},
                ) as response:
                    if response.status_code != 200:
                        try:
                            retry = max(1, min(1800, int(response.headers.get("Retry-After", "1"))))
                        except ValueError:
                            retry = 1
                        raise HTTPFailure(response.status_code, retry)
                    chunks = bytearray()
                    for chunk in response.iter_bytes():
                        chunks.extend(chunk)
                        if len(chunks) > limit:
                            raise AuthorityError("authority response exceeds protocol size bound")
                    return bytes(chunks) if raw else decode(chunks)
            except httpx.TransportError:
                if attempt + 1 == attempts:
                    raise AuthorityError("authority transport failed; rerun to reconcile") from None
                if self.epoch is not None:
                    self.guard()
        raise AssertionError("unreachable")

    def poison(self):
        with self.lock:
            self.poisoned = True

    def guard(self):
        with self.lock:
            if self.poisoned or self.epoch is None or self.monotonic() >= self.deadline:
                self.poisoned = True
                raise AuthorityError("remote lease lost or expired; fresh attempt required")

    def acknowledge(self, response, started):
        epoch = number(response.get("epoch"), 1)
        remaining = (
            number(response.get("expires_at")) - number(response.get("server_time"))
        ) / 1000
        if not 0 < remaining <= 120 or self.epoch is not None and epoch != self.epoch:
            raise AuthorityError("invalid lease acknowledgement")
        with self.lock:
            if self.poisoned or self.epoch is not None and self.monotonic() >= self.deadline:
                self.poisoned = True
                raise AuthorityError("remote lease expired during renewal")
            self.epoch = epoch
            # Request start, not response receipt: conservative against latency and suspension.
            self.deadline = started + remaining - 2
            if self.monotonic() >= self.deadline:
                self.poisoned = True
                raise AuthorityError("remote lease acknowledgement expired")

    def acquire(self):
        if self.epoch is not None or self.poisoned:
            raise AuthorityError("cannot reacquire a running attempt")
        end = self.monotonic() + self.cfg.remote_state.lease_wait_seconds
        body = {"action": "acquire", "nonce": self.nonce, "request_id": str(uuid.uuid4())}
        while True:
            started = self.monotonic()
            try:
                self.acknowledge(self.request("POST", "lease", body), started)
                break
            except HTTPFailure as exc:
                if exc.status != 409:
                    raise
                remaining = end - self.monotonic()
                if remaining <= 0:
                    raise AuthorityError("lease wait timed out; rerun with fresh source") from None
                self.stop.wait(min(remaining, exc.retry_after + random.uniform(0, 0.25)))
        self.thread = threading.Thread(target=self.heartbeat, name="wiki-rag-lease", daemon=True)
        self.thread.start()

    def renew(self):
        try:
            self.guard()
            started = self.monotonic()
            self.acknowledge(
                self.request("POST", "lease", {"action": "renew", **self.proof()}), started
            )
        except Exception:
            self.poison()
            raise

    def heartbeat(self):
        while not self.stop.wait(self.heartbeat_seconds):
            try:
                self.renew()
            except Exception:
                return

    def proof(self):
        return {"epoch": self.epoch, "nonce": self.nonce}

    def finish(self, *, suppress=False):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=35)
        try:
            if self.epoch is not None:
                self.guard()
                self.request("POST", "lease", {"action": "release", **self.proof()})
        except AuthorityError:
            self.poison()
            if not suppress:
                raise
        finally:
            self.client.close()

    def status(self):
        result = self.request("GET", "status")
        if not isinstance(result, dict) or result.get("ownership") != self.cfg.ownership:
            raise AuthorityError("remote authority ownership mismatch")
        number(result.get("revision"))
        if type(result.get("initialized")) is not bool:
            raise AuthorityError("invalid authority initialization state")
        job = result.get("job")
        if job is not None:
            if (
                not isinstance(job, dict)
                or job.get("status")
                not in {"pending", "complete", "failed", "superseded", "revoked"}
                or not isinstance(job.get("id"), str)
                or not re.fullmatch(r"[0-9a-f-]{36}", job["id"])
                or number(job.get("total")) > 10000
                or number(job.get("completed")) > job["total"]
            ):
                raise AuthorityError("invalid authority job status")
            if "error" in job and (
                not isinstance(job["error"], str)
                or not re.fullmatch(r"[a-z0-9_-]{1,80}", job["error"])
            ):
                raise AuthorityError("invalid authority job error")
            if "diagnostics" in job:
                validate_job_diagnostics(job["diagnostics"])
            if "publication_id" in job and (
                not isinstance(job["publication_id"], str)
                or not re.fullmatch(r"[0-9a-f-]{36}", job["publication_id"])
            ):
                raise AuthorityError("invalid authority job publication")
            for field in ("created_at", "finished_at", "duration_ms"):
                if field in job and job[field] is not None:
                    number(job[field])
        return result

    def load(self):
        self.guard()
        try:
            status = self.status()
            self.revision = status["revision"]
            value = self.request("POST", "snapshot", {**self.proof(), "revision": self.revision})
            if value != status:
                raise AuthorityError("remote snapshot changed unexpectedly")
            return value
        except AuthorityError:
            self.poison()
            raise

    def publication(self):
        for attempt in range(3):
            meta = self.request("GET", "publication")
            if meta is None:
                return None
            try:
                if not isinstance(meta, dict) or set(meta) != {
                    "generation",
                    "parts",
                    "bytes",
                    "digest",
                }:
                    raise AuthorityError("invalid publication metadata")
                if (
                    not re.fullmatch(r"o-[0-9a-f]{64}", meta["generation"])
                    or not re.fullmatch(r"[0-9a-f]{64}", meta["digest"])
                    or not 1 <= number(meta["parts"], 1) <= 16
                    or not 1 <= number(meta["bytes"], 1) <= SNAPSHOT_LIMIT
                ):
                    raise AuthorityError("invalid publication bounds")
                data = bytearray()
                for part in range(meta["parts"]):
                    data.extend(
                        self.request(
                            "GET",
                            "publication",
                            raw=True,
                            limit=900 * 1024,
                            params={"generation": meta["generation"], "part": part},
                        )
                    )
                    if len(data) > meta["bytes"]:
                        raise AuthorityError("publication size mismatch")
                if len(data) != meta["bytes"] or hashlib.sha256(data).hexdigest() != meta["digest"]:
                    raise AuthorityError("publication digest mismatch")
                snapshot = decode(data)
                if snapshot.get("projectId") != self.cfg.project_id or snapshot.get("stores") != {
                    c.name: c.vector_store_id for c in self.cfg.collections
                }:
                    raise AuthorityError("publication binding mismatch")
                return snapshot["manifest"]
            except HTTPFailure as exc:
                if exc.status == 409 and self.epoch is None and attempt < 2:
                    continue
                if self.epoch is not None:
                    self.poison()
                raise
        raise AuthorityError("publication changed during preview; retry")

    def command(self, route, **fields):
        self.guard()
        body = {
            **self.proof(),
            "expected_revision": self.revision,
            "request_id": str(uuid.uuid4()),
            **fields,
        }
        try:
            result = self.request("POST", route, body)
            if number(result.get("revision")) != self.revision + 1:
                raise AuthorityError("invalid authority command revision")
            self.revision = result["revision"]
            if route == "publish":
                self.committed_publication = decode(fields["manifestText"])["publication_id"]
            self.guard()
            return result
        except AuthorityError:
            self.poison()
            raise

    def checkpoint(self, oid, operation, retired_id=None):
        retired = [{"id": oid, "retired_id": retired_id}] if retired_id else []
        return self.checkpoint_many([{"id": oid, "operation": operation}], retired)

    def checkpoint_many(self, upserts, retire=()):
        """Keep every phase transition, using count- and byte-bounded deltas."""
        retired = {item["id"]: item for item in retire}
        chunks, batch = [], []
        for item in upserts:
            if len(encode(item["operation"])) > 8192:
                raise AuthorityError("operation exceeds protocol size bound")
            candidate = batch + [item]
            fields = {
                "upserts": candidate,
                "retire": [retired[i["id"]] for i in candidate if i["id"] in retired],
            }
            if len(candidate) > 100 or len(encode(fields)) > SMALL_LIMIT - 1024:
                chunks.append(batch)
                batch = [item]
            else:
                batch = candidate
        if batch:
            chunks.append(batch)
        result = None
        for batch in chunks:
            fields = {"upserts": batch}
            entries = [retired[i["id"]] for i in batch if i["id"] in retired]
            if entries:
                fields["retire"] = entries
            result = self.command("checkpoint", **fields)
        return result

    def operations(self, **fields):
        self.guard()
        try:
            result = self.request(
                "POST", "operations", {**self.proof(), "revision": self.revision, **fields}
            )
            if (
                result.get("revision") != self.revision
                or not isinstance(result.get("items"), list)
                or len(result["items"]) > 100
            ):
                raise AuthorityError("invalid operations page")
            return result
        except AuthorityError:
            self.poison()
            raise

    def lookup(self, ids):
        if not 1 <= len(ids) <= 50:
            raise AuthorityError("operation lookup requires 1..50 IDs")
        result = self.operations(ids=ids)
        if result.get("next") is not None or any(item["id"] not in ids for item in result["items"]):
            raise AuthorityError("invalid operation lookup")
        return {item["id"]: item["operation"] for item in result["items"]}

    def cleanup_pages(self):
        after = ""
        for _ in range(100001):
            result = self.operations(after=after, limit=100, cleanup=True)
            items = result["items"]
            ids = [item["id"] for item in items]
            nxt = result.get("next")
            if ids != sorted(set(ids)) or any(i <= after for i in ids):
                raise AuthorityError("operations cursor did not progress")
            if nxt is not None and (not ids or nxt != ids[-1] or nxt <= after):
                raise AuthorityError("invalid operations cursor")
            yield items
            if nxt is None:
                return
            after = nxt
        raise AuthorityError("operations pagination limit reached")
