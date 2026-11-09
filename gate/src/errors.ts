export class GateError extends Error {
  constructor(
    readonly code:
      | "ACCESS_DENIED"
      | "INVALID_INPUT"
      | "UNAUTHENTICATED"
      | "NOT_FOUND"
      | "BUSY"
      | "CANCELLED"
      | "CONFLICT",
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
