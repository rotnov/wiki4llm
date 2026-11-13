import { z } from "zod";
import type { StateReader, Workspace } from "./state-contract.js";
import type {
  Backend,
  DocumentMetadata,
  ReadFormat,
  EffectiveQuery,
} from "./backend.js";
import { resolveSelection, validateSlug, repositorySchema } from "./policy.js";
import { GateError, denied, invalid } from "./errors.js";
// Covers UTF-8/base64 expansion of a 1024-character path plus identifiers.
const MAX_REFERENCE_LENGTH = 8192;
// Keep essential guidance in tool prose: some connectors flatten detailed schemas.
const parameterDescriptions = {
  offset:
    "offset: integer 0-100000, default 0. Use returned nextOffset for the next page; null means no more pages.",
  workspaceLimit: "limit: integer 1-50, default 20 workspaces per page.",
  query: "query: trimmed nonempty search text, 1-4096 characters.",
  workspaces:
    "workspaces: up to 20 selectors, each at most 80 characters; names or wildcard masks within authorized grants. When omitted, use all effective grants (at most 20 workspaces); empty selection is rejected.",
  mode: "mode: lex, vec or hybrid, default hybrid. QMD lex is model-free; OpenAI modes control embedding/text weights.",
  queryLimit: "limit: integer 1-20, default 10 results.",
  ref: "ref: exact document reference returned by query or find_documents, at most 8192 characters.",
  fromLine: "fromLine: integer 1-1000000, default 1; one-based starting line.",
  maxLines:
    "maxLines: optional integer 1-200; omitted returns all remaining parsed lines.",
  format:
    "format: parsed (default) returns complete available parsed text; original returns verified uploaded bytes. Ranges apply only to parsed.",
  refs: "refs: 1-20 exact document references returned by query or find_documents, each at most 8192 characters.",
};
const selectors = z
  .array(z.string().max(80))
  .max(20)
  .optional()
  .describe(parameterDescriptions.workspaces);
export const toolSchemas = {
  list_workspaces: z
    .object({
      offset: z
        .number()
        .int()
        .min(0)
        .max(100000)
        .default(0)
        .describe(parameterDescriptions.offset),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(20)
        .describe(parameterDescriptions.workspaceLimit),
    })
    .strict(),
  query: z
    .object({
      query: z
        .string()
        .trim()
        .min(1)
        .max(4096)
        .describe(parameterDescriptions.query),
      workspaces: selectors,
      rewrite_query: z
        .boolean()
        .default(false)
        .optional()
        .describe(
          "rewrite_query: boolean, default false. Opt in to native OpenAI query rewriting; unsupported for QMD. Returns bounded effectiveQueries metadata when true.",
        ),
      mode: z
        .enum(["lex", "vec", "hybrid"])
        .default("hybrid")
        .describe(parameterDescriptions.mode),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(10)
        .describe(parameterDescriptions.queryLimit),
    })
    .strict(),
  find_documents: z
    .object({
      workspace: z
        .string()
        .min(1)
        .max(80)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .describe(
          "workspace: one required exact authorized workspace slug; no masks or inferred default.",
        ),
      query: z
        .string()
        .trim()
        .min(1)
        .max(1024)
        .describe(
          "query: trimmed literal case-insensitive path fragment, 1-1024 characters; no glob, regex or token expansion.",
        ),
      repository: repositorySchema
        .optional()
        .describe(
          "repository: optional exact case-sensitive repository identity, 1-256 characters; filtered before ranking/limit, no normalization or masks.",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe(
          "limit: integer 1-20, default 5 results; hasMore reports omitted matches, with no pagination.",
        ),
    })
    .strict(),
  get: z
    .object({
      ref: z
        .string()
        .max(MAX_REFERENCE_LENGTH)
        .describe(parameterDescriptions.ref),
      format: z
        .enum(["parsed", "original"])
        .default("parsed")
        .describe(parameterDescriptions.format),
      fromLine: z
        .number()
        .int()
        .min(1)
        .max(1000000)
        .optional()
        .describe(parameterDescriptions.fromLine),
      maxLines: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe(parameterDescriptions.maxLines),
    })
    .strict(),
  multi_get: z
    .object({
      format: z
        .enum(["parsed", "original"])
        .default("parsed")
        .describe(parameterDescriptions.format),
      refs: z
        .array(z.string().max(MAX_REFERENCE_LENGTH))
        .min(1)
        .max(20)
        .describe(parameterDescriptions.refs),
      maxLines: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe(parameterDescriptions.maxLines),
    })
    .strict(),
  status: z.object({ workspaces: selectors }).strict(),
};
export const toolDescriptions: Record<keyof typeof toolSchemas, string> = {
  list_workspaces:
    "List authorized workspaces. limit 1-50 (default 20); offset default 0. Pass nextOffset as offset for the next page; null means done.",
  query:
    "Discover authorized documents; OpenAI: one full first-ranked excerpt. limit 1-20 (default 10); workspaces omitted: all authorized, at most 20. lex/vec/hybrid (default hybrid). rewrite_query: false; true OpenAI-only. Prefer local repository + relative path with own tools; report revision differences. Use get if unavailable. source.sha256 hashes original bytes.",
  find_documents:
    "Find published paths in one exact authorized OpenAI workspace by literal case-insensitive fragment. Optional exact case-sensitive repository filter precedes ranking; limit 1-20 (default 5). No bodies/provider calls. hasMore signals omitted matches; narrow query/repository or raise limit, no pagination. Use refs with get/multi_get; paths do not prove authority. QMD unsupported.",
  get: "Read query/find_documents ref: format parsed (default) returns full available text; original returns verified bytes (binary MCP resource). Prefer accessible local repository + relative path using your own tools; report revision differences. Use get if unavailable. Optional maxLines 1-200, fromLine one-based (default 1), parsed only. source.sha256 hashes original bytes, not parsed text.",
  multi_get:
    "Read 1-20 authorized query/find_documents refs. format parsed (default): full text from first line; optional maxLines 1-200. original: verified bytes (binary MCP resources), no ranges. Prefer accessible local repository + relative path with your own tools; report revision differences. Use remote reads if local tools unavailable. source.sha256 hashes original bytes, not excerpts.",
  status:
    "Get document counts and background indexing status. workspaces: authorized names or masks; omitted means all authorized workspaces, at most 20; empty selection rejected.",
};
export type ToolName = keyof typeof toolSchemas;
function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) invalid();
  return parsed.data;
}
export function validatePath(path: string): string {
  if (
    typeof path !== "string" ||
    path.length > 1024 ||
    !path ||
    /[\\%:#\x00-\x1f\x7f]/.test(path) ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    invalid("Invalid document path");
  return path;
}
interface Reference {
  workspace: string;
  generation: string;
  collection: string;
  path: string;
}
export function encodeReference(
  workspace: string,
  generation: string,
  collection: string,
  path: string,
): string {
  [workspace, generation, collection].forEach(validateSlug);
  validatePath(path);
  return (
    "qgdoc:" +
    Buffer.from(
      JSON.stringify([1, workspace, generation, collection, path]),
    ).toString("base64url")
  );
}
export function parseReference(ref: string): Reference {
  if (
    typeof ref !== "string" ||
    ref.length > MAX_REFERENCE_LENGTH ||
    !/^qgdoc:[A-Za-z0-9_-]+$/.test(ref)
  )
    invalid("Invalid document reference");
  const encoded = ref.slice(6),
    text = Buffer.from(encoded, "base64url").toString("utf8");
  if (Buffer.from(text).toString("base64url") !== encoded)
    invalid("Invalid document reference");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalid("Invalid document reference");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    value[0] !== 1 ||
    !value.slice(1).every((x) => typeof x === "string")
  )
    invalid("Invalid document reference");
  const [, workspace, generation, collection, path] = value as [
    number,
    string,
    string,
    string,
    string,
  ];
  [workspace, generation, collection].forEach(validateSlug);
  validatePath(path);
  return { workspace, generation, collection, path };
}
function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new GateError("CANCELLED", "Request cancelled");
}
export class Gateway {
  constructor(
    private readonly state: StateReader,
    private readonly backend: Backend,
  ) {}
  async execute(
    tokenId: string,
    tool: string,
    args: unknown,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<Record<string, unknown>> {
    cancelled(signal);
    const context = this.state.context(tokenId);
    const selected = new Map<string, Workspace>();
    const authorize = (ids: string[]) =>
      ids.map((id) => {
        if (!context.allowed.includes(id)) denied();
        const w = selected.get(id) ?? this.state.workspace(id);
        selected.set(id, w);
        return w;
      });
    const resolveRef = (ref: Reference) => {
      const w = authorize([ref.workspace])[0]!;
      if (w.generation !== ref.generation)
        throw new GateError("NOT_FOUND", "Document unavailable");
      return w;
    };
    const describe = (w: Workspace, d: DocumentMetadata) => ({
      ref: encodeReference(w.id, w.generation!, d.collection, d.path),
      workspace: w.id,
      generation: w.generation,
      collection: d.collection,
      path: d.path,
      title: d.title.slice(0, 500),
      source: d.source ?? {
        kind: "local",
        collection: d.collection,
        path: d.path,
      },
    });
    const read = async (
      w: Workspace,
      ref: Reference,
      fromLine: number,
      maxLines: number | undefined,
      format: ReadFormat,
    ) => {
      cancelled(signal);
      if (format === "original" && w.backend !== "openai")
        throw new GateError("UNSUPPORTED_FORMAT");
      const doc = await this.backend.read(
        w,
        ref.collection,
        ref.path,
        signal,
        format,
      );
      if (!doc || doc.collection !== ref.collection || doc.path !== ref.path)
        throw new GateError("NOT_FOUND", "Document unavailable");
      if (format === "original") {
        if (!doc.original) throw new GateError("UNSUPPORTED_FORMAT");
        const { blob, ...metadata } = doc.original;
        return {
          ...describe(w, doc),
          format,
          complete: true,
          ...metadata,
          representation:
            blob === undefined ? "original-text" : "original-binary",
          ...(blob === undefined
            ? { text: doc.body }
            : {
                resource: {
                  uri: encodeReference(
                    w.id,
                    w.generation!,
                    doc.collection,
                    doc.path,
                  ),
                  mimeType: metadata.mimeType,
                  blob,
                },
              }),
        };
      }
      const lines = doc.body.split("\n");
      const end =
        maxLines === undefined
          ? lines.length
          : Math.min(lines.length, fromLine - 1 + maxLines);
      return {
        ...describe(w, doc),
        format,
        representation: "parsed-text",
        mimeType: "text/plain; charset=utf-8",
        fromLine,
        totalLines: lines.length,
        complete: fromLine === 1 && end >= lines.length,
        nextLine: end < lines.length ? end + 1 : null,
        text: lines.slice(fromLine - 1, end).join("\n"),
      };
    };
    const validateDelivery = () => {
      cancelled(signal);
      const current = this.state.context(tokenId);
      for (const [id, w] of selected) {
        if (!current.allowed.includes(id)) denied();
        if (this.state.workspace(id).generation !== w.generation)
          throw new GateError("CONFLICT", "Index changed; repeat the query");
      }
    };
    let result: Record<string, unknown>;
    try {
      switch (tool) {
        case "list_workspaces": {
          const a = parse(toolSchemas.list_workspaces, args);
          const ids = context.allowed.slice(a.offset, a.offset + a.limit);
          result = {
            workspaces: ids.map((id) => {
              const w = this.state.workspace(id);
              return { id: w.id, indexed: w.generation !== null };
            }),
            nextOffset:
              a.offset + a.limit < context.allowed.length
                ? a.offset + a.limit
                : null,
          };
          break;
        }
        case "query": {
          const a = parse(toolSchemas.query, args),
            workspaces = authorize(
              resolveSelection(context.allowed, a.workspaces),
            );
          if (a.rewrite_query && workspaces.some((w) => w.backend !== "openai"))
            throw new GateError("UNSUPPORTED_OPERATION");
          const hits = [];
          const effectiveQueries: (EffectiveQuery & { workspace: string })[] =
            [];
          let queryBytesRemaining = 4096;
          for (const w of workspaces) {
            cancelled(signal);
            if (!w.generation)
              throw new GateError("NOT_FOUND", "Workspace data unavailable");
            const found = await this.backend.search(
              w,
              a.query,
              a.mode,
              a.limit,
              signal,
              a.rewrite_query ? { rewriteQuery: true } : undefined,
            );
            if (a.rewrite_query) {
              for (const entry of found.effectiveQueries ?? []) {
                const bytes = Buffer.byteLength(
                  JSON.stringify(entry.search_query),
                );
                const search_query =
                  bytes <= queryBytesRemaining ? entry.search_query : null;
                if (search_query !== null) queryBytesRemaining -= bytes;
                effectiveQueries.push({
                  workspace: w.id,
                  collection: entry.collection,
                  search_query,
                });
              }
            }
            for (const [rank, hit] of found.hits.slice(0, a.limit).entries())
              hits.push({
                ...describe(w, hit),
                score: 1 / (61 + rank),
                snippet: hit.body,
              });
          }
          hits.sort(
            (a, b) =>
              b.score - a.score ||
              a.workspace.localeCompare(b.workspace) ||
              a.path.localeCompare(b.path),
          );
          result = {
            results: hits.slice(0, a.limit),
            ...(a.rewrite_query ? { effectiveQueries } : {}),
            searchedWorkspaces: workspaces.map((w) => w.id),
            ranking: "per-workspace reciprocal rank (k=60)",
            ...(workspaces.some((w) => w.backend === "openai")
              ? {
                  retrieval: {
                    openai:
                      "First 50 chunks per collection; one full first-ranked excerpt per active document before collection reciprocal rank (k=60). Document discovery, not exhaustive context: later same-document hits are omitted; use get for full content. No search pagination or source offsets. Response budget overflow errors rather than clipping. Modes control OpenAI embedding/text weights, not QMD-equivalent ranking.",
                  },
                }
              : {}),
          };
          break;
        }
        case "find_documents": {
          const a = parse(toolSchemas.find_documents, args),
            w = authorize([a.workspace])[0]!;
          if (!w.generation) throw new GateError("NOT_FOUND");
          if (!this.backend.findDocuments)
            throw new GateError("UNSUPPORTED_OPERATION");
          const found = await this.backend.findDocuments(
            w,
            a.query,
            a.repository,
            a.limit,
            signal,
          );
          result = {
            results: found.results.map((d) => describe(w, d)),
            hasMore: found.hasMore,
          };
          break;
        }
        case "get": {
          const a = parse(toolSchemas.get, args),
            ref = parseReference(a.ref),
            w = resolveRef(ref);
          if (
            a.format === "original" &&
            (a.fromLine !== undefined || a.maxLines !== undefined)
          )
            invalid("Ranges require parsed format");
          result = await read(w, ref, a.fromLine ?? 1, a.maxLines, a.format);
          break;
        }
        case "multi_get": {
          const a = parse(toolSchemas.multi_get, args),
            refs = a.refs.map(parseReference),
            workspaces = refs.map(resolveRef);
          if (a.format === "original" && a.maxLines !== undefined)
            invalid("Ranges require parsed format");
          const documents = [];
          for (let i = 0; i < refs.length; i++)
            documents.push(
              await read(workspaces[i]!, refs[i]!, 1, a.maxLines, a.format),
            );
          result = { documents };
          break;
        }
        case "status": {
          const a = parse(toolSchemas.status, args),
            workspaces = authorize(
              resolveSelection(context.allowed, a.workspaces),
            ),
            statuses = [];
          for (const w of workspaces) {
            cancelled(signal);
            statuses.push({
              id: w.id,
              generation: w.generation,
              ...(await this.backend.status(w, signal)),
            });
          }
          result = { workspaces: statuses };
          break;
        }
        default:
          invalid("Unsupported tool");
      }
    } catch (error) {
      validateDelivery();
      if (error instanceof GateError) throw error;
      throw new GateError("NOT_FOUND", "Workspace data unavailable");
    }
    validateDelivery();
    const maxOutput =
      tool === "get" || tool === "multi_get" ? 4 * 1024 * 1024 : 65536;
    if (Buffer.byteLength(JSON.stringify(result)) > maxOutput)
      throw new GateError("CONTENT_TOO_LARGE");
    return result;
  }
}
