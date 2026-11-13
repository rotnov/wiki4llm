import {
  readFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  writeFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  Backend,
  Document,
  Hit,
  SearchMode,
  SearchOptions,
  SearchResult,
} from "./backend.js";
import type { Workspace } from "./state.js";
import { validateSlug } from "./policy.js";
import { validatePath } from "./gateway.js";
import { GateError } from "./errors.js";
// Private QMD seam: deliberately pinned and guarded. Keep all private access here.
let owned = false;
export class QmdBackend implements Backend {
  private readonly stores = new Map<string, any>();
  private closed = false;
  get runtimeCount(): number {
    return new Set([
      this.runtime,
      this.llmApi.getDefaultLlamaCpp(),
      ...Array.from(this.stores.values(), (s) => s.llm),
    ]).size;
  }
  private constructor(
    private readonly dir: string,
    private readonly api: any,
    private readonly llmApi: any,
    private readonly runtime: any,
  ) {}
  static async open(dir: string): Promise<QmdBackend> {
    if (owned)
      throw new GateError("CONFLICT", "One QMD runtime owner per process");
    owned = true;
    try {
      const entry = fileURLToPath(import.meta.resolve("@tobilu/qmd")),
        dist = dirname(entry);
      const pkg = JSON.parse(
        readFileSync(join(dist, "../package.json"), "utf8"),
      );
      if (pkg.version !== "2.8.3") throw new Error("Unsupported QMD version");
      const api = await import(pathToFileURL(join(dist, "store.js")).href),
        llm = await import(pathToFileURL(join(dist, "llm.js")).href);
      if (llm.hasDefaultLlamaCpp())
        throw new Error("QMD runtime already initialized");
      const runtime = new llm.LlamaCpp({
        modelCacheDir: join(resolve(dir), "models"),
      });
      llm.setDefaultLlamaCpp(runtime);
      return new QmdBackend(resolve(dir), api, llm, runtime);
    } catch (error) {
      owned = false;
      throw error;
    }
  }
  private store(w: Workspace): any {
    if (this.closed || !w.generation) throw new GateError("NOT_FOUND");
    validateSlug(w.id);
    validateSlug(w.generation);
    const key = w.id + "/" + w.generation;
    let store = this.stores.get(key);
    if (!store) {
      const db = join(this.dir, "indexes", key, "index.sqlite");
      if (!existsSync(db)) throw new GateError("NOT_FOUND");
      store = this.api.createStore(db);
      store.llm = this.runtime;
      this.stores.set(key, store);
    }
    return store;
  }
  async index(w: Workspace, embed: boolean): Promise<string> {
    validateSlug(w.id);
    const generation = "g-" + randomUUID(),
      root = join(this.dir, "indexes", w.id, generation);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    let store: any;
    try {
      store = this.api.createStore(join(root, "index.sqlite"));
      store.llm = this.runtime;
      for (const source of w.sources) {
        validateSlug(source.name);
        const target = join(root, "sources", source.name);
        mkdirSync(target, { recursive: true });
        const origin = realpathSync(source.path);
        let bytes = 0,
          count = 0;
        const copy = (relative: string) => {
          for (const item of readdirSync(join(origin, relative), {
            withFileTypes: true,
          })) {
            if (
              item.name.startsWith(".") ||
              [
                "node_modules",
                "vendor",
                "dist",
                "build",
                "local-evidence",
              ].includes(item.name)
            )
              continue;
            const path = relative ? relative + "/" + item.name : item.name;
            validatePath(path);
            const full = join(origin, path),
              stat = lstatSync(full);
            if (stat.isSymbolicLink())
              throw new GateError(
                "INVALID_INPUT",
                "Symbolic links are not accepted",
              );
            if (stat.isDirectory()) {
              mkdirSync(join(target, path), { recursive: true });
              copy(path);
            } else if (stat.isFile() && /\.mdx?$/.test(item.name)) {
              if (
                stat.size > 1048576 ||
                (bytes += stat.size) > 268435456 ||
                ++count > 10000
              )
                throw new GateError(
                  "INVALID_INPUT",
                  "Source exceeds indexing limits",
                );
              const data = readFileSync(full);
              if (data.length > 1048576)
                throw new GateError("INVALID_INPUT", "Document too large");
              new TextDecoder("utf-8", { fatal: true }).decode(data);
              writeFileSync(join(target, path), data, { mode: 0o600 });
            }
          }
        };
        copy("");
        this.api.upsertStoreCollection(store.db, source.name, {
          path: target,
          pattern: "**/*.{md,mdx}",
        });
        const result = await this.api.reindexCollection(
          store,
          target,
          "**/*.{md,mdx}",
          source.name,
        );
        if (result.skippedFiles?.length) throw new Error("Incomplete index");
      }
      if (embed) {
        const result = await this.api.generateEmbeddings(store);
        if (result.errors) throw new Error("Incomplete embeddings");
      }
      return generation;
    } catch (error) {
      store?.close();
      store = undefined;
      rmSync(root, { recursive: true, force: true });
      throw error;
    } finally {
      store?.close();
    }
  }
  async read(
    w: Workspace,
    collection: string,
    path: string,
    signal: AbortSignal,
  ): Promise<Document | undefined> {
    signal.throwIfAborted();
    validateSlug(collection);
    validatePath(path);
    const row = this.store(w)
      .db.prepare(
        "SELECT d.collection,d.path,d.title,c.doc AS body FROM documents d JOIN content c ON c.hash=d.hash WHERE d.active=1 AND d.collection=? AND d.path=?",
      )
      .get(collection, path);
    return row
      ? {
          collection: String(row.collection),
          path: String(row.path),
          title: String(row.title),
          body: String(row.body),
        }
      : undefined;
  }
  async search(
    w: Workspace,
    query: string,
    mode: SearchMode,
    limit: number,
    signal: AbortSignal,
    options?: SearchOptions,
  ): Promise<SearchResult> {
    if (options?.rewriteQuery) throw new GateError("UNSUPPORTED_OPERATION");
    signal.throwIfAborted();
    const store = this.store(w);
    const results =
      mode === "lex"
        ? store.searchFTS(query, limit)
        : mode === "vec"
          ? await this.api.vectorSearchQuery(store, query, { limit })
          : await this.api.hybridQuery(store, query, {
              limit,
              candidateLimit: 20,
            });
    const hits: Hit[] = [];
    for (const result of results) {
      signal.throwIfAborted();
      const uri = String(result.filepath ?? result.file);
      const match = /^qmd:\/\/([^/]+)\/(.+)$/.exec(uri);
      if (!match) throw new Error("Unexpected QMD result");
      const doc = await this.read(w, match[1]!, match[2]!, signal);
      if (!doc) throw new Error("Missing QMD document");
      hits.push({ ...doc, score: Number(result.score) });
    }
    return { hits };
  }
  async status(
    w: Workspace,
    signal: AbortSignal,
  ): Promise<{ documents: number; vectors: number }> {
    signal.throwIfAborted();
    if (!w.generation) return { documents: 0, vectors: 0 };
    const db = this.store(w).db;
    return {
      documents: Number(
        db.prepare("SELECT COUNT(*) AS n FROM documents WHERE active=1").get()
          .n,
      ),
      vectors: Number(
        db.prepare("SELECT COUNT(*) AS n FROM content_vectors").get().n,
      ),
    };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      for (const store of this.stores.values()) store.close();
      this.stores.clear();
      await this.llmApi.disposeDefaultLlamaCpp();
    } finally {
      owned = false;
    }
  }
}
