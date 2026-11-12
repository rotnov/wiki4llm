import { z } from "zod";
import type { StateReader, Workspace } from "./state-contract.js";
import type { Backend, Document } from "./backend.js";
import { resolveSelection, validateSlug } from "./policy.js";
import { GateError, denied, invalid } from "./errors.js";
// Covers UTF-8/base64 expansion of a 1024-character path plus identifiers.
const MAX_REFERENCE_LENGTH = 8192;
// Keep parameter guidance in both schemas and tool prose: some connectors flatten schemas.
const parameterDescriptions = {
  offset:
    "offset: integer 0-100000, default 0. Use returned nextOffset for the next page; null means no more pages.",
  workspaceLimit: "limit: integer 1-50, default 20 workspaces per page.",
  query: "query: trimmed nonempty search text, 1-4096 characters.",
  workspaces:
    "workspaces: up to 20 selectors, each at most 80 characters; names or wildcard masks within authorized grants. When omitted, use all effective grants (at most 20 workspaces); empty selection is rejected.",
  mode: "mode: lex, vec or hybrid, default hybrid. QMD lex is model-free; OpenAI modes control embedding/text weights.",
  queryLimit: "limit: integer 1-20, default 10 results.",
  ref: "ref: exact document reference returned by query, at most 8192 characters.",
  fromLine: "fromLine: integer 1-1000000, default 1; one-based starting line.",
  maxLines: "maxLines: integer 1-200, default 80 lines per document.",
  refs: "refs: 1-20 exact document references returned by query, each at most 8192 characters.",
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
  get: z
    .object({
      ref: z
        .string()
        .max(MAX_REFERENCE_LENGTH)
        .describe(parameterDescriptions.ref),
      fromLine: z
        .number()
        .int()
        .min(1)
        .max(1000000)
        .default(1)
        .describe(parameterDescriptions.fromLine),
      maxLines: z
        .number()
        .int()
        .min(1)
        .max(200)
        .default(80)
        .describe(parameterDescriptions.maxLines),
    })
    .strict(),
  multi_get: z
    .object({
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
        .default(80)
        .describe(parameterDescriptions.maxLines),
    })
    .strict(),
  status: z.object({ workspaces: selectors }).strict(),
};
export const toolDescriptions: Record<keyof typeof toolSchemas, string> = {
  list_workspaces: `List workspaces this credential may read. ${parameterDescriptions.offset} ${parameterDescriptions.workspaceLimit}`,
  query: `Search authorized workspaces. ${parameterDescriptions.query} ${parameterDescriptions.workspaces} ${parameterDescriptions.mode} ${parameterDescriptions.queryLimit}`,
  get: `Read an exact document reference returned by query. ${parameterDescriptions.ref} ${parameterDescriptions.fromLine} ${parameterDescriptions.maxLines}`,
  multi_get: `Read exact authorized document references from their first line. ${parameterDescriptions.refs} ${parameterDescriptions.maxLines}`,
  status: `Get published document counts and available background indexing status for authorized workspaces. ${parameterDescriptions.workspaces}`,
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
    const describe = (w: Workspace, d: Document) => ({
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
      maxLines: number,
    ) => {
      cancelled(signal);
      const doc = await this.backend.read(w, ref.collection, ref.path, signal);
      if (!doc || doc.collection !== ref.collection || doc.path !== ref.path)
        throw new GateError("NOT_FOUND", "Document unavailable");
      const lines = doc.body.split("\n");
      return {
        ...describe(w, doc),
        fromLine,
        totalLines: lines.length,
        text: lines.slice(fromLine - 1, fromLine - 1 + maxLines).join("\n"),
      };
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
          const hits = [];
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
            );
            for (const [rank, hit] of found.slice(0, a.limit).entries())
              hits.push({
                ...describe(w, hit),
                score: 1 / (61 + rank),
                snippet: hit.body.slice(0, 800),
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
            searchedWorkspaces: workspaces.map((w) => w.id),
            ranking: "per-workspace reciprocal rank (k=60)",
            ...(workspaces.some((w) => w.backend === "openai")
              ? {
                  retrieval: {
                    openai:
                      "First 50 chunks per collection; active documents deduplicated before collection reciprocal rank (k=60). No search pagination; results may be incomplete. Modes control OpenAI embedding/text weights, not QMD-equivalent ranking.",
                  },
                }
              : {}),
          };
          break;
        }
        case "get": {
          const a = parse(toolSchemas.get, args),
            ref = parseReference(a.ref),
            w = resolveRef(ref);
          result = await read(w, ref, a.fromLine, a.maxLines);
          break;
        }
        case "multi_get": {
          const a = parse(toolSchemas.multi_get, args),
            refs = a.refs.map(parseReference),
            workspaces = refs.map(resolveRef);
          const documents = [];
          for (let i = 0; i < refs.length; i++)
            documents.push(await read(workspaces[i]!, refs[i]!, 1, a.maxLines));
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
      if (error instanceof GateError) throw error;
      throw new GateError("NOT_FOUND", "Workspace data unavailable");
    }
    cancelled(signal);
    const current = this.state.context(tokenId);
    for (const [id, w] of selected) {
      if (!current.allowed.includes(id)) denied();
      if (this.state.workspace(id).generation !== w.generation)
        throw new GateError("CONFLICT", "Index changed; repeat the query");
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 65536)
      invalid("Response exceeds 64 KiB; request fewer documents or lines");
    return result;
  }
}
