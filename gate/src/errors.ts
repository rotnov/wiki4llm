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
      "Original file download failed. Ask the operator to verify Files content read permission and availability; use parsed format or a local source.",
  };
  return explanations[error.code]
    ? `${error.code}: ${explanations[error.code]}`
    : error.code;
}
