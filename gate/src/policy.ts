import { denied, invalid } from "./errors.js";
export interface Grants {
  allow: string[];
  deny: string[];
}
export function validateSlug(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 80 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  )
    invalid("Invalid workspace slug");
  return value;
}
export function validatePattern(value: string): string {
  if (value === "*") return value;
  if (typeof value !== "string") invalid("Invalid grant pattern");
  if (value.endsWith("-*")) validateSlug(value.slice(0, -2));
  else validateSlug(value);
  return value;
}
export function validateGrants(grants: Grants): void {
  if (
    !grants ||
    !Array.isArray(grants.allow) ||
    !Array.isArray(grants.deny) ||
    grants.allow.length + grants.deny.length > 100
  )
    invalid("Invalid grants");
  [...grants.allow, ...grants.deny].forEach(validatePattern);
}
function matches(pattern: string, slug: string): boolean {
  return (
    pattern === "*" ||
    (pattern.endsWith("-*")
      ? slug.startsWith(pattern.slice(0, -1))
      : slug === pattern)
  );
}
export function selectWorkspaces(
  registry: string[],
  grants: Grants,
  constraints?: Grants,
): string[] {
  registry.forEach(validateSlug);
  validateGrants(grants);
  if (constraints) validateGrants(constraints);
  const permits = (slug: string, g: Grants) =>
    g.allow.some((p) => matches(p, slug)) &&
    !g.deny.some((p) => matches(p, slug));
  return [...new Set(registry)].filter(
    (slug) =>
      permits(slug, grants) && (!constraints || permits(slug, constraints)),
  );
}
export function resolveSelection(
  allowed: string[],
  requested?: string[],
): string[] {
  if (!allowed.length || requested?.length === 0) denied();
  if (
    requested !== undefined &&
    (!Array.isArray(requested) || requested.length > 20)
  )
    invalid("Too many workspace selectors");
  const selected = new Set<string>();
  if (requested === undefined) allowed.forEach((x) => selected.add(x));
  else
    for (const item of requested) {
      validatePattern(item);
      if (!item.includes("*") && !allowed.includes(item)) denied();
      allowed.filter((x) => matches(item, x)).forEach((x) => selected.add(x));
    }
  if (!selected.size) denied();
  if (selected.size > 20) invalid("Select at most 20 workspaces");
  return [...selected];
}
