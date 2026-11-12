export class GateError extends Error {
  constructor(
    readonly code:
      | "ACCESS_DENIED"
      | "INVALID_INPUT"
      | "UNAUTHENTICATED"
      | "NOT_FOUND"
      | "BUSY"
      | "CANCELLED"
      | "CONFLICT"
      | "INCOMPLETE_CONTENT"
      | "CONTENT_TOO_LARGE"
      | "CONTENT_MISMATCH"
      | "UNSUPPORTED_CONTENT"
      | "UNSUPPORTED_FORMAT"
      | "ORIGINAL_UNAVAILABLE",
    message: string = code,
  ) {
    super(message);
  }
}
// Provider diagnostics are opt-in and allowlisted; never retain a raw error body.
export class OriginalDownloadError extends GateError {
  readonly diagnostics: Readonly<Record<string, string | number>>;
  constructor(status: number, requestId: string | null, body: unknown) {
    super("ORIGINAL_UNAVAILABLE");
    const details: Record<string, string | number> = {};
    if (Number.isInteger(status) && status >= 100 && status <= 599)
      details.status = status;
    if (requestId && /^req_[a-f0-9]{16,64}$/i.test(requestId))
      details.requestId = requestId;
    const error =
      body && typeof body === "object" && "error" in body
        ? body.error
        : undefined;
    if (error && typeof error === "object") {
      const value = error as Record<string, unknown>;
      const types = [
        "invalid_request_error",
        "authentication_error",
        "rate_limit_error",
        "server_error",
      ];
      const codes = [
        "invalid_request_error",
        "invalid_api_key",
        "permission_denied",
        "insufficient_permissions",
        "not_found",
        "file_not_found",
        "rate_limit_exceeded",
        "insufficient_quota",
        "server_error",
        "internal_error",
        "unsupported_file",
        "unsupported_file_purpose",
      ];
      if (typeof value.type === "string" && types.includes(value.type))
        details.type = value.type;
      if (typeof value.code === "string" && codes.includes(value.code))
        details.code = value.code;
      // A fixed classification is evidence only when the provider says exactly this.
      if (
        value.message ===
          "Not allowed to download files of purpose: assistants" ||
        value.message ===
          "Not allowed to download files of purpose: assistants."
      )
        details.classification = "purpose_not_downloadable";
    }
    this.diagnostics = Object.freeze(details);
  }
}

export function invalid(message = "Invalid input"): never {
  throw new GateError("INVALID_INPUT", message);
}
export function denied(): never {
  throw new GateError("ACCESS_DENIED", "Access denied");
}

// Only fixed, reviewed explanations are exposed; never echo provider/state errors.
export function publicError(error: unknown): string {
  if (!(error instanceof GateError)) return "NOT_FOUND";
  const explanations: Record<string, string> = {
    INCOMPLETE_CONTENT:
      "Provider content is incomplete; continuation is unsupported. For parsed reads try format=original; otherwise use a matching local source.",
    CONTENT_TOO_LARGE:
      "Content exceeds the provider 2 MiB or tool response budget (query 64 KiB; reads 4 MiB). Request fewer results/documents or explicit parsed line ranges; use a local source for larger files. Nothing was truncated.",
    CONTENT_MISMATCH:
      "Original bytes do not match the published source hash; no content returned. Ask the publisher to verify the active file.",
    UNSUPPORTED_CONTENT:
      "Provider returned an unsupported parsed representation. Try format=original or a matching local source; no partial content was returned.",
    UNSUPPORTED_FORMAT:
      "Original bytes are unavailable for this backend or the published text is not valid UTF-8. Use parsed format or a matching local source.",
    ORIGINAL_UNAVAILABLE:
      "Original file download failed. Inspect diagnostics before attributing it to file-purpose restrictions, Files content read permission or availability; use parsed format or a local source.",
  };
  const message = explanations[error.code]
    ? `${error.code}: ${explanations[error.code]}`
    : error.code;
  return error instanceof OriginalDownloadError
    ? `${message} Provider diagnostics: ${JSON.stringify(error.diagnostics)}`
    : message;
}
