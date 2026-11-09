import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  selectWorkspaces,
  validateGrants,
  validateSlug,
  type Grants,
} from "./policy.js";
import {
  parseManifest,
  manifestGeneration,
  validatePublication,
  type OpenAIBinding,
  type OpenAISnapshot,
} from "./manifest.js";
import { GateError, invalid } from "./errors.js";
import type { Source, Workspace, Context } from "./state-contract.js";
export type { Source, Workspace, Context } from "./state-contract.js";
export interface IssuedToken {
  id: string;
  secret: string;
  name: string;
  expiresAt: number;
}
interface CredentialRow {
  id: string;
  principal_id: string;
  expires_at: number;
  revoked: number;
  constraints_json: string | null;
  enabled: number;
  grants_json: string;
}
export class State {
  readonly dir: string;
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(
    dir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, "gate.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS principals(id TEXT PRIMARY KEY,grants_json TEXT NOT NULL,enabled INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,generation TEXT,sources_json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS openai_snapshots(workspace TEXT PRIMARY KEY REFERENCES workspaces(id),snapshot_json TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS openai_publications(workspace TEXT NOT NULL REFERENCES workspaces(id),publication TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(workspace,publication));
   CREATE TABLE IF NOT EXISTS tokens(id TEXT PRIMARY KEY,hash TEXT UNIQUE NOT NULL,principal_id TEXT NOT NULL REFERENCES principals(id),name TEXT NOT NULL,expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,constraints_json TEXT);
   CREATE TABLE IF NOT EXISTS policy_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
   INSERT OR IGNORE INTO policy_revision VALUES(1,0);`);
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  private bump(): void {
    this.db.exec("UPDATE policy_revision SET revision=revision+1 WHERE id=1");
  }
  setPrincipal(id: string, grants: Grants, enabled = true): void {
    validateSlug(id);
    validateGrants(grants);
    this.db
      .prepare(
        "INSERT INTO principals VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET grants_json=excluded.grants_json,enabled=excluded.enabled",
      )
      .run(id, JSON.stringify(grants), enabled ? 1 : 0);
    this.bump();
  }
  setWorkspace(id: string, sources: Source[] = []): void {
    validateSlug(id);
    if (
      this.db
        .prepare("SELECT 1 FROM openai_snapshots WHERE workspace=?")
        .get(id)
    )
      invalid("OpenAI workspace cannot be converted to QMD");
    if (sources.length > 20) invalid("Too many sources");
    const names = new Set<string>();
    for (const s of sources) {
      validateSlug(s.name);
      if (typeof s.path !== "string" || !s.path || names.has(s.name))
        invalid("Invalid source");
      names.add(s.name);
    }
    this.db
      .prepare(
        "INSERT INTO workspaces VALUES(?,NULL,?) ON CONFLICT(id) DO UPDATE SET sources_json=excluded.sources_json",
      )
      .run(id, JSON.stringify(sources));
    this.bump();
  }
  publishGeneration(id: string, generation: string): void {
    validateSlug(generation);
    if (this.workspace(id).backend === "openai")
      invalid("Use explicit OpenAI manifest import");
    this.db
      .prepare("UPDATE workspaces SET generation=? WHERE id=?")
      .run(generation, id);
    this.bump();
  }
  workspace(id: string): Workspace {
    validateSlug(id);
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id=?").get(id);
    if (!row) throw new GateError("NOT_FOUND", "Workspace unavailable");
    const snapshot = this.db
      .prepare("SELECT snapshot_json FROM openai_snapshots WHERE workspace=?")
      .get(id);
    return {
      ...(snapshot
        ? {
            backend: "openai" as const,
            openai: JSON.parse(
              String(snapshot.snapshot_json),
            ) as OpenAISnapshot,
          }
        : {}),
      id: String(row.id),
      generation: row.generation === null ? null : String(row.generation),
      sources: JSON.parse(String(row.sources_json)) as Source[],
    };
  }
  importOpenAI(id: string, text: string, binding: OpenAIBinding): Workspace {
    validateSlug(id);
    const manifest = parseManifest(text, binding),
      generation = manifestGeneration(manifest);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db
        .prepare("SELECT snapshot_json FROM openai_snapshots WHERE workspace=?")
        .get(id);
      const prior = old
        ? (JSON.parse(String(old.snapshot_json)) as OpenAISnapshot)
        : undefined;
      if (
        !prior &&
        this.db.prepare("SELECT 1 FROM workspaces WHERE id=?").get(id)
      )
        invalid("Existing QMD workspace cannot be converted to OpenAI");
      const seen = this.db
        .prepare(
          "SELECT generation FROM openai_publications WHERE workspace=? AND publication=?",
        )
        .get(id, manifest.publication_id);
      validatePublication(
        binding,
        manifest,
        generation,
        prior
          ? {
              binding: {
                projectId: prior.projectId,
                credentialEnv: prior.credentialEnv,
                stores: prior.stores,
              },
              sequence: prior.manifest.generation,
              publication: prior.manifest.publication_id,
              generation: manifestGeneration(prior.manifest),
            }
          : undefined,
        seen ? String(seen.generation) : undefined,
      );
      this.db
        .prepare(
          "INSERT INTO workspaces VALUES(?,?,'[]') ON CONFLICT(id) DO UPDATE SET generation=excluded.generation",
        )
        .run(id, generation);
      this.db
        .prepare(
          "INSERT INTO openai_snapshots VALUES(?,?) ON CONFLICT(workspace) DO UPDATE SET snapshot_json=excluded.snapshot_json",
        )
        .run(id, JSON.stringify({ ...binding, manifest }));
      this.db
        .prepare("INSERT OR IGNORE INTO openai_publications VALUES(?,?,?)")
        .run(id, manifest.publication_id, generation);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.workspace(id);
  }
  workspaces(): Workspace[] {
    return this.db
      .prepare("SELECT id FROM workspaces ORDER BY rowid")
      .all()
      .map((r) => this.workspace(String(r.id)));
  }
  issueToken(
    principal: string,
    name: string,
    expiresAt: number,
    constraints?: Grants,
  ): IssuedToken {
    validateSlug(principal);
    if (
      typeof name !== "string" ||
      !name ||
      name.length > 100 ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= this.now()
    )
      invalid("Invalid token name or expiry");
    if (
      !this.db
        .prepare("SELECT id FROM principals WHERE id=? AND enabled=1")
        .get(principal)
    )
      throw new GateError("NOT_FOUND", "Principal unavailable");
    if (constraints) validateGrants(constraints);
    const secret = "qg_" + randomBytes(32).toString("base64url"),
      id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO tokens(id,hash,principal_id,name,expires_at,constraints_json) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        createHash("sha256").update(secret).digest("hex"),
        principal,
        name,
        expiresAt,
        constraints ? JSON.stringify(constraints) : null,
      );
    return { id, secret, name, expiresAt };
  }
  revokeToken(id: string): void {
    this.db.prepare("UPDATE tokens SET revoked=1 WHERE id=?").run(id);
    this.bump();
  }
  authenticate(header: string | undefined): Context {
    if (
      typeof header !== "string" ||
      !/^Bearer qg_[A-Za-z0-9_-]{43}$/.test(header)
    )
      throw new GateError("UNAUTHENTICATED");
    const hash = createHash("sha256").update(header.slice(7)).digest("hex");
    const row = this.db.prepare("SELECT id FROM tokens WHERE hash=?").get(hash);
    if (!row) throw new GateError("UNAUTHENTICATED");
    return this.context(String(row.id));
  }
  context(id: string): Context {
    const row = this.db
      .prepare(
        "SELECT t.*,p.enabled,p.grants_json FROM tokens t JOIN principals p ON t.principal_id=p.id WHERE t.id=?",
      )
      .get(id) as unknown as CredentialRow | undefined;
    if (!row || row.revoked || !row.enabled || row.expires_at <= this.now())
      throw new GateError("UNAUTHENTICATED");
    const revision = Number(
      this.db.prepare("SELECT revision FROM policy_revision WHERE id=1").get()!
        .revision,
    );
    return {
      tokenId: row.id,
      principalId: row.principal_id,
      allowed: selectWorkspaces(
        this.workspaces().map((w) => w.id),
        JSON.parse(row.grants_json) as Grants,
        row.constraints_json === null
          ? undefined
          : (JSON.parse(row.constraints_json) as Grants),
      ),
      revision,
    };
  }
}
