"""Bounded provider diagnostics; never serialize HTTP bodies or authorization headers."""

import re

FIELDS = {
    "files",
    "file_ids",
    "file_id",
    "attributes",
    "repository",
    "path",
    "commit",
    "kind",
    "collection",
    "branch",
    "sha256",
    "operation_id",
    "source_kind",
    "chunking_strategy",
    "type",
    "static",
    "max_chunk_size_tokens",
    "chunk_overlap_tokens",
    "purpose",
}
TYPES = {"invalid_request_error", "server_error", "rate_limit_error", "authentication_error"}
CODES = {
    "invalid_value",
    "invalid_type",
    "invalid_parameter",
    "missing_required_parameter",
    "unsupported_parameter",
    "unknown_parameter",
    "rate_limit_exceeded",
    "insufficient_quota",
    "server_error",
    "internal_error",
    "invalid_api_key",
    "permission_denied",
    "not_found",
    "context_length_exceeded",
    "file_too_large",
    "vector_store_limit_exceeded",
}


def route_shape(path):
    return "/".join(
        part if part in {"files", "vector_stores", "file_batches", "content"} else "{id}"
        for part in path.split("/")
    )


def parameter(value):
    if not isinstance(value, str) or len(value) > 150:
        return None
    parts = re.split(r"[.\[\]]", value)
    return value if all(not part or part in FIELDS or part.isdecimal() for part in parts) else None


def sanitized_message(message, sensitive):
    if not isinstance(message, str):
        return None
    # Redact before bounding output so a clipped credential cannot evade matching.
    for value in sorted(set(sensitive), key=len, reverse=True):
        if value:
            message = message.replace(value, "[redacted]")
    message = re.sub(r"https?://[^\s]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[redacted]", message)
    message = re.sub(r"\b(?:sk-|file-|vs_|vsfb_)[A-Za-z0-9_-]+", "[redacted]", message)
    message = re.sub(
        r"(['\"`])([^'\"`]*?)\1",
        lambda m: m.group(0) if parameter(m.group(2)) else "'[redacted]'",
        message,
    )
    return " ".join(message.split())[:1000]


def error_details(response, *, sensitive=()):
    try:
        failure = response.json().get("error", {})
    except ValueError, AttributeError:
        return {"reason": "non-JSON provider error"}
    if not isinstance(failure, dict):
        return {"reason": "unstructured provider error"}
    result = {}
    if isinstance(failure.get("type"), str) and failure["type"] in TYPES:
        result["type"] = failure["type"]
    if isinstance(failure.get("code"), str) and failure["code"] in CODES:
        result["code"] = failure["code"]
    if value := parameter(failure.get("param")):
        result["param"] = value
    if value := sanitized_message(failure.get("message"), sensitive):
        result["reason"] = value
    return result


def attribute_values(payload):
    if not isinstance(payload, dict):
        return []
    records = payload.get("files", [payload])
    if not isinstance(records, list):
        return []
    return [
        str(value)
        for record in records
        if isinstance(record, dict)
        for value in (record.get("attributes") or {}).values()
        if isinstance(value, (str, int, float))
    ]
