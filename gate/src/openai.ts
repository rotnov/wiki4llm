import { z } from "zod";
import { createHash } from "node:crypto";
import type {
  Backend,
  Document,
  DocumentMetadata,
  DocumentDiscovery,
  Hit,
  SearchMode,
  SearchOptions,
  IndexingStatus,
  ReadFormat,
} from "./backend.js";
import type { Workspace } from "./state-contract.js";
import type { OpenAISnapshot } from "./manifest.js";
import {
  ContentTooLargeError,
  GateError,
  OriginalDownloadError,
  invalid,
} from "./errors.js";
const MAX_RESPONSE = 2097152;
const textParts = z
  .array(z.object({ type: z.literal("text"), text: z.string() }))
  .max(1000);
const page = z.object({
  data: z.array(z.unknown()).max(1000),
  has_more: z.boolean(),
  next_page: z.string().max(256).nullable().optional(),
});
// The enclosing request deadline also bounds diagnostic reads. Never log the body.
async function originalFailure(
  response: Response,
): Promise<OriginalDownloadError> {
  let body: unknown;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) break;
        chunks.push(value);
      }
      if (size <= 8192)
        body = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
    } catch {
      // Malformed, oversized or unavailable diagnostics never replace the failure.
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  return new OriginalDownloadError(
    response.status,
    response.headers.get("x-request-id"),
    body,
  );
}

export interface OpenAIOptions {
  // Programmatic test seam only; never exposed by CLI, persisted config or MCP.
  transport?: (url: string, init: RequestInit) => Promise<Response>;
  env?: Record<string, string | undefined>;
  snapshot?: (workspace: Workspace) => OpenAISnapshot;
  indexing?: (workspace: Workspace) => IndexingStatus | null;
  timeoutMs?: number;
}
export class OpenAIBackend implements Backend {
  private readonly transport: NonNullable<OpenAIOptions["transport"]>;
  private readonly env: Record<string, string | undefined>;
  private readonly resolveSnapshot: OpenAIOptions["snapshot"];
  private readonly timeoutMs: number;
  private readonly resolveIndexing: OpenAIOptions["indexing"];
  constructor(options: OpenAIOptions = {}) {
    this.resolveSnapshot = options.snapshot;
    this.resolveIndexing = options.indexing;
    this.transport = options.transport ?? ((url, init) => fetch(url, init));
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 15000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 15000
    )
      throw new GateError("INVALID_INPUT");
  }
  private snapshot(w: Workspace): OpenAISnapshot {
    const snapshot = this.resolveSnapshot ? this.resolveSnapshot(w) : w.openai;
    if (w.backend !== "openai" || !snapshot || !w.generation)
      throw new GateError("NOT_FOUND");
    return snapshot;
  }
  private async request(
    s: OpenAISnapshot,
    path: string,
    signal: AbortSignal,
    body?: unknown,
    original = false,
  ): Promise<unknown> {
    if (signal.aborted) throw new GateError("CANCELLED", "Request cancelled");
    const key = this.env[s.credentialEnv];
    if (
      !key ||
      !/^sk-[A-Za-z0-9_-]{8,512}$/.test(key) ||
      key.startsWith("sk-admin-")
    )
      throw new GateError(
        "NOT_FOUND",
        "OpenAI project query credential unavailable",
      );
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    let rejectAbort: (e: unknown) => void = () => {};
    const aborted = new Promise<never>((_, reject) => (rejectAbort = reject));
    const onAbort = () =>
      rejectAbort(
        new GateError(
          "CANCELLED",
          "OpenAI request cancelled or deadline exceeded",
        ),
      );
    abort.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(cancel, this.timeoutMs);
    try {
      return await Promise.race([
        aborted,
        (async () => {
          const response = await this.transport(
            "https://api.openai.com/v1" + path,
            {
              method: body === undefined ? "GET" : "POST",
              redirect: "error",
              headers: {
                Authorization: "Bearer " + key,
                "OpenAI-Project": s.projectId,
                "Content-Type": "application/json",
              },
              signal: abort.signal,
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            },
          );
          if (!response.ok || response.redirected) {
            if (original) throw await originalFailure(response);
            await response.body?.cancel();
            throw new GateError("NOT_FOUND", "OpenAI request failed");
          }
          if (
            response.status !== 200 ||
            response.headers.has("content-range")
          ) {
            await response.body?.cancel();
            throw new GateError("INCOMPLETE_CONTENT");
          }
          if (Number(response.headers.get("content-length")) > MAX_RESPONSE) {
            await response.body?.cancel();
            throw new ContentTooLargeError("provider_response", MAX_RESPONSE);
          }
          if (!response.body)
            throw new GateError("NOT_FOUND", "Invalid OpenAI response");
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > MAX_RESPONSE)
                throw new ContentTooLargeError(
                  "provider_response",
                  MAX_RESPONSE,
                );
              chunks.push(value);
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          const bytes = Buffer.concat(chunks);
          if (original) return bytes;
          return JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
        })(),
      ]);
    } catch (error) {
      if (error instanceof GateError) throw error;
      throw new GateError(
        "NOT_FOUND",
        "OpenAI request or response unavailable",
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      abort.signal.removeEventListener("abort", onAbort);
      abort.abort();
    }
  }
  private metadata(
    s: OpenAISnapshot,
    name: string,
    path: string,
  ): DocumentMetadata {
    const c = s.manifest.collections[name]!,
      f = c.files[path]!;
    return {
      collection: name,
      path,
      title: path.split("/").at(-1)!,
      source: {
        kind: "openai",
        repository: c.repository,
        path,
        sourceCommit: f.source_commit,
        repositoryCommit: c.repository_commit,
        publicationId: s.manifest.publication_id,
        sha256: f.sha256,
        fileKind: f.kind,
        lineBasis: "none",
        ...(f.origin ? { origin: f.origin } : {}),
      },
    };
  }
  private document(
    s: OpenAISnapshot,
    name: string,
    path: string,
    body: string,
  ): Document {
    const metadata = this.metadata(s, name, path);
    return {
      ...metadata,
      body,
      source: { ...metadata.source!, lineBasis: "parsed-text" },
    };
  }
  async findDocuments(
    w: Workspace,
    query: string,
    repository: string | undefined,
    limit: number,
    signal: AbortSignal,
  ): Promise<DocumentDiscovery> {
    if (signal.aborted) throw new GateError("CANCELLED");
    const snapshot = this.snapshot(w),
      needle = query.toLowerCase();
    const matches: {
      repository: string;
      collection: string;
      path: string;
      rank: number;
    }[] = [];
    for (const [collection, c] of Object.entries(
      snapshot.manifest.collections,
    )) {
      if (repository !== undefined && c.repository !== repository) continue;
      for (const path of Object.keys(c.files)) {
        if (!path.toLowerCase().includes(needle)) continue;
        const basename = path.split("/").at(-1)!.toLowerCase();
        matches.push({
          repository: c.repository,
          collection,
          path,
          rank: basename === needle ? 0 : basename.includes(needle) ? 1 : 2,
        });
      }
    }
    const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    matches.sort(
      (a, b) =>
        a.rank - b.rank ||
        compare(a.repository, b.repository) ||
        compare(a.collection, b.collection) ||
        compare(a.path, b.path),
    );
    if (signal.aborted) throw new GateError("CANCELLED");
    return {
      results: matches
        .slice(0, limit)
        .map(({ collection, path }) =>
          this.metadata(snapshot, collection, path),
        ),
      hasMore: matches.length > limit,
    };
  }
  async search(
    w: Workspace,
    query: string,
    mode: SearchMode,
    limit: number,
    signal: AbortSignal,
    options?: SearchOptions,
  ): Promise<Hit[]> {
    if (
      options?.openaiRanker !== undefined &&
      options.openaiRanker !== "auto" &&
      options.openaiRanker !== "none"
    )
      invalid();
    const s = this.snapshot(w),
      hits: Hit[] = [];
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    const weights = {
      lex: { embedding_weight: 0, text_weight: 1 },
      vec: { embedding_weight: 1, text_weight: 0 },
      hybrid: { embedding_weight: 1, text_weight: 1 },
    };
    for (const [name, c] of Object.entries(s.manifest.collections)) {
      const raw = await this.request(
        s,
        `/vector_stores/${c.vector_store_id}/search`,
        bounded,
        {
          query,
          max_num_results: 50,
          rewrite_query: false,
          ranking_options: {
            hybrid_search: weights[mode],
            ...(options?.openaiRanker !== undefined
              ? { ranker: options.openaiRanker }
              : {}),
          },
        },
      );
      const parsed = page.safeParse(raw);
      if (!parsed.success || parsed.data.data.length > 50)
        throw new GateError("NOT_FOUND", "Invalid OpenAI search response");
      const active = new Map(
        Object.entries(c.files).map(([path, f]) => [f.file_id, path]),
      );
      const seen = new Set<string>();
      let rank = 0;
      for (const item of parsed.data.data) {
        if (!item || typeof item !== "object")
          throw new GateError("NOT_FOUND", "Invalid OpenAI search response");
        const row = item as Record<string, unknown>;
        const path = active.get(String(row.file_id));
        if (
          !path ||
          seen.has(path) ||
          (row.vector_store_id !== undefined &&
            row.vector_store_id !== c.vector_store_id)
        )
          continue;
        const content = textParts.safeParse(row.content);
        if (!content.success)
          throw new GateError("NOT_FOUND", "Invalid OpenAI search content");
        seen.add(path);
        hits.push({
          ...this.document(
            s,
            name,
            path,
            content.data.map((x) => x.text).join("\n"),
          ),
          score: 1 / (61 + rank++),
        });
      }
    }
    return hits
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.collection.localeCompare(b.collection) ||
          a.path.localeCompare(b.path),
      )
      .slice(0, limit);
  }
  async read(
    w: Workspace,
    collection: string,
    path: string,
    signal: AbortSignal,
    format: ReadFormat = "parsed",
  ): Promise<Document | undefined> {
    const s = this.snapshot(w);
    if (!Object.hasOwn(s.manifest.collections, collection)) return undefined;
    const c = s.manifest.collections[collection]!;
    if (!Object.hasOwn(c.files, path)) return undefined;
    const f = c.files[path]!;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    if (format === "original") {
      const bytes = (await this.request(
        s,
        `/files/${f.file_id}/content`,
        bounded,
        undefined,
        true,
      )) as Buffer;
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== f.sha256) throw new GateError("CONTENT_MISMATCH");
      const binary = f.preprocessing === "pdf-native-v1";
      let body = "";
      if (!binary) {
        try {
          // Preserve the UTF-8 BOM as a character so re-encoding is byte-faithful.
          body = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(bytes);
        } catch {
          throw new GateError("UNSUPPORTED_FORMAT");
        }
      }
      const doc = this.document(s, collection, path, body);
      doc.source!.lineBasis = binary ? "none" : "original-text";
      doc.original = {
        mimeType: binary
          ? "application/pdf"
          : f.kind === "md"
            ? "text/markdown; charset=utf-8"
            : "text/plain; charset=utf-8",
        byteLength: bytes.length,
        sha256,
        ...(binary ? { blob: bytes.toString("base64") } : {}),
      };
      return doc;
    }
    const raw = await this.request(
      s,
      `/vector_stores/${c.vector_store_id}/files/${f.file_id}/content`,
      bounded,
    );
    const parsed = page.safeParse(raw);
    if (!parsed.success)
      throw new GateError(
        "UNSUPPORTED_CONTENT",
        "Invalid parsed content response",
      );
    // The published content API does not specify a continuation request parameter.
    // Refuse partial documents until that protocol is qualified against the provider.
    if (parsed.data.has_more)
      throw new GateError(
        "INCOMPLETE_CONTENT",
        "Parsed content pagination is not supported",
      );
    const content = textParts.safeParse(parsed.data.data);
    if (!content.success)
      throw new GateError(
        "UNSUPPORTED_CONTENT",
        "Invalid parsed content response",
      );
    const body = content.data.map((p) => p.text).join("\n");
    if (Buffer.byteLength(body) > MAX_RESPONSE)
      throw new ContentTooLargeError("parsed_content", MAX_RESPONSE);
    return this.document(s, collection, path, body);
  }
  async status(
    w: Workspace,
    signal: AbortSignal,
  ): Promise<{
    documents: number;
    vectors: null;
    backend: "openai";
    indexing?: IndexingStatus;
  }> {
    if (signal.aborted) throw new GateError("CANCELLED");
    const s = this.snapshot(w);
    const indexing = this.resolveIndexing?.(w);
    return {
      documents: Object.values(s.manifest.collections).reduce(
        (n, c) => n + Object.keys(c.files).length,
        0,
      ),
      vectors: null,
      backend: "openai",
      ...(indexing ? { indexing } : {}),
    };
  }
}
