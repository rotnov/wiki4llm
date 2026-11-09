import { z } from "zod";
import { createHash } from "node:crypto";
import { invalid } from "./errors.js";
import { validateSlug } from "./policy.js";
import { validatePath } from "./gateway.js";
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const project = z.string().regex(/^proj_[A-Za-z0-9_-]{1,160}$/);
const store = z.string().regex(/^vs_[A-Za-z0-9_-]{1,160}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
  .nullable();
const plain = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const file = z
  .object({
    path: z.string(),
    file_id: z.string().regex(/^file[-_][A-Za-z0-9_-]{1,160}$/),
    vector_store_id: store,
    sha256: hash,
    version: hash,
    kind: z.string().regex(/^[a-z0-9]{1,20}$/),
    source_commit: commit,
    preprocessing: z.enum(["utf8-text-v1", "pdf-native-v1"]),
    operation_id: plain,
  })
  .strict();
const collection = z
  .object({
    repository: plain.refine(
      (v) =>
        !v.startsWith("/") &&
        !v.includes("\\") &&
        !v.split("/").some((p) => !p || p === "." || p === ".."),
    ),
    branch: plain.nullable(),
    vector_store_id: store,
    repository_commit: commit,
    processing: z
      .object({
        preprocessing: z.literal("per-file-v1"),
        chunking: z
          .object({
            type: z.literal("static"),
            static: z
              .object({
                max_chunk_size_tokens: z.number().int().min(100).max(4096),
                chunk_overlap_tokens: z.number().int().min(0).max(2048),
              })
              .strict()
              .refine(
                (v) => v.chunk_overlap_tokens <= v.max_chunk_size_tokens / 2,
              ),
          })
          .strict(),
      })
      .strict(),
    files: z.record(z.string(), file),
  })
  .strict();
const schema = z
  .object({
    schema_version: z.literal(1),
    project_id: project,
    publication_id: z.uuid(),
    generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    published_at: z.iso.datetime({ offset: true }),
    collections: z.record(z.string(), collection),
  })
  .strict();
export type Manifest = z.infer<typeof schema>;
export interface OpenAIBinding {
  projectId: string;
  credentialEnv: string;
  stores: Record<string, string>;
}
export interface OpenAISnapshot extends OpenAIBinding {
  manifest: Manifest;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
// JSON.parse alone silently keeps the last duplicate key, including escaped aliases.
export function uniqueKeys(text: string): void {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)!;
  let i = 0;
  function value(depth: number): void {
    if (depth > 24) invalid("Manifest nesting exceeds limit");
    const t = tokens[i++];
    if (t === "{") {
      const keys = new Set<string>();
      if (tokens[i] === "}") {
        i++;
        return;
      }
      while (true) {
        const key = JSON.parse(tokens[i++]!);
        if (keys.has(key)) invalid("Duplicate manifest key");
        keys.add(key);
        i++;
        value(depth + 1);
        if (tokens[i++] === "}") break;
      }
    } else if (t === "[") {
      if (tokens[i] === "]") {
        i++;
        return;
      }
      while (true) {
        value(depth + 1);
        if (tokens[i++] === "]") break;
      }
    }
  }
  value(0);
}
export function parseManifest(text: string, binding: OpenAIBinding): Manifest {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_MANIFEST_BYTES)
    invalid("Manifest exceeds 8 MiB");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
    uniqueKeys(text);
  } catch {
    invalid("Invalid manifest JSON or duplicate keys");
  }
  const result = schema.safeParse(raw);
  if (!result.success) invalid("Unsupported or malformed published manifest");
  const m = result.data;
  if (
    !project.safeParse(binding.projectId).success ||
    m.project_id !== binding.projectId
  )
    invalid("Manifest project does not match binding");
  if (
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(binding.credentialEnv) ||
    /ADMIN/i.test(binding.credentialEnv)
  )
    invalid("Use a named project query credential environment variable");
  const entries = Object.entries(m.collections);
  if (
    entries.length < 1 ||
    entries.length > 20 ||
    canonical(
      Object.fromEntries(entries.map(([k, c]) => [k, c.vector_store_id])),
    ) !== canonical(binding.stores)
  )
    invalid(
      "Manifest collection/store mapping does not match binding (1..20 collections)",
    );
  const stores = new Set<string>(),
    files = new Set<string>(),
    paths = new Set<string>();
  let count = 0;
  for (const [name, c] of entries) {
    try {
      validateSlug(name);
    } catch {
      invalid("Collection name is incompatible with gate slug contract");
    }
    if (stores.has(c.vector_store_id)) invalid("Ambiguous collection store");
    stores.add(c.vector_store_id);
    for (const [path, f] of Object.entries(c.files)) {
      validatePath(path);
      if (
        ++count > 10000 ||
        f.path !== path ||
        f.vector_store_id !== c.vector_store_id ||
        files.has(f.file_id) ||
        paths.has(c.repository + "\0" + path)
      )
        invalid("Duplicate or mismatched manifest file identity");
      if (
        (f.kind === "pdf") !== (f.preprocessing === "pdf-native-v1") ||
        path.split(".").at(-1)?.toLowerCase() !== f.kind
      )
        invalid("Invalid file processing identity");
      files.add(f.file_id);
      paths.add(c.repository + "\0" + path);
    }
  }
  return m;
}
export function manifestGeneration(m: Manifest): string {
  return "o-" + createHash("sha256").update(canonical(m)).digest("hex");
}
// Compact comparison state shared by Node and Durable Object publication stores.
export interface PriorPublication {
  binding: OpenAIBinding;
  sequence: number;
  publication: string;
  generation: string;
}
export function validatePublication(
  binding: OpenAIBinding,
  manifest: Manifest,
  generation: string,
  prior?: PriorPublication,
  seenGeneration?: string,
): void {
  if (prior) {
    if (canonical(prior.binding) !== canonical(binding))
      invalid(
        "OpenAI binding is immutable; use a new workspace for a new authority",
      );
    if (manifest.generation < prior.sequence)
      invalid("Manifest generation rollback");
    if (
      manifest.generation === prior.sequence &&
      generation !== prior.generation
    )
      invalid("Manifest generation content changed");
    if (
      manifest.generation > prior.sequence &&
      manifest.publication_id === prior.publication
    )
      invalid("Publication identity reused");
  }
  if (seenGeneration !== undefined && seenGeneration !== generation)
    invalid("Publication identity reused");
}
