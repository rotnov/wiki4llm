export function emailAddress(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(
      value,
    )
  )
    return undefined;
  // Access email matching is case-insensitive. No provider-specific alias rewriting.
  return value.toLowerCase();
}
