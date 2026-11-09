import type {
  DurableObjectStorage,
  SqlStorageValue,
} from "@cloudflare/workers-types/index.js";
import { createHash } from "node:crypto";
import type { Context, StateReader, Workspace } from "../state-contract.js";
import {
  parseManifest,
  manifestGeneration,
  validatePublication,
  type OpenAIBinding,
  type OpenAISnapshot,
  type PriorPublication,
  type Manifest,
} from "../manifest.js";
import {
  selectWorkspaces,
  validateSlug,
  validateGrants,
  type Grants,
} from "../policy.js";
import { GateError, invalid } from "../errors.js";
import { validIdentityKey, type Identity } from "./access.js";
const CHUNK_BYTES = 900 * 1024;
export class CloudState {
  constructor(
    private readonly storage: DurableObjectStorage,
    readonly issuer: string,
    readonly audience: string,
  ) {
    storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS authority(id INTEGER PRIMARY KEY,issuer TEXT NOT NULL,audience TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS principals(id TEXT PRIMARY KEY,grants_json TEXT NOT NULL,enabled INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS identities(issuer TEXT NOT NULL,key TEXT NOT NULL,principal TEXT NOT NULL,enabled INTEGER NOT NULL,PRIMARY KEY(issuer,key));
   CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,generation TEXT NOT NULL,prior_json TEXT NOT NULL,parts INTEGER NOT NULL,bytes INTEGER NOT NULL,digest TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS parts(workspace TEXT NOT NULL,part INTEGER NOT NULL,payload BLOB NOT NULL,PRIMARY KEY(workspace,part));
   CREATE TABLE IF NOT EXISTS publications(workspace TEXT NOT NULL,publication TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(workspace,publication));
   CREATE TABLE IF NOT EXISTS ingest_reservations(project TEXT NOT NULL,store TEXT NOT NULL,workspace TEXT NOT NULL,PRIMARY KEY(project,store));
   CREATE TABLE IF NOT EXISTS revision(id INTEGER PRIMARY KEY,value INTEGER NOT NULL);
   INSERT OR IGNORE INTO revision VALUES(1,0);`);
    storage.sql.exec(
      "INSERT OR IGNORE INTO authority VALUES(1,?,?)",
      issuer,
      audience,
    );
  }
  private rows(query: string, ...args: SqlStorageValue[]) {
    return this.storage.sql.exec(query, ...args).toArray();
  }
  checkAuthority() {
    const r = this.rows("SELECT issuer,audience FROM authority WHERE id=1")[0];
    if (!r || r.issuer !== this.issuer || r.audience !== this.audience)
      throw new GateError("CONFLICT");
  }
  private bump() {
    this.storage.sql.exec("UPDATE revision SET value=value+1 WHERE id=1");
  }
  setPrincipal(id: string, grants: Grants, enabled: boolean) {
    validateSlug(id);
    validateGrants(grants);
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "INSERT INTO principals VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET grants_json=excluded.grants_json,enabled=excluded.enabled",
        id,
        JSON.stringify(grants),
        +enabled,
      );
      this.bump();
    });
  }
  bind(key: string, principal: string, enabled: boolean) {
    if (!validIdentityKey(key)) invalid();
    validateSlug(principal);
    if (!this.rows("SELECT id FROM principals WHERE id=?", principal).length)
      invalid();
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "INSERT INTO identities VALUES(?,?,?,?) ON CONFLICT(issuer,key) DO UPDATE SET principal=excluded.principal,enabled=excluded.enabled",
        this.issuer,
        key,
        principal,
        +enabled,
      );
      this.bump();
    });
  }
  unbind(key: string) {
    if (!validIdentityKey(key)) invalid();
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "DELETE FROM identities WHERE issuer=? AND key=?",
        this.issuer,
        key,
      );
      this.bump();
    });
  }
  view(identity: Identity): StateReader {
    return {
      context: () => this.context(identity),
      workspace: (id) => {
        const c = this.context(identity);
        if (!c.allowed.includes(id)) throw new GateError("ACCESS_DENIED");
        return this.workspace(id);
      },
    };
  }
  context(identity: Identity): Context {
    this.checkAuthority();
    if (identity.issuer !== this.issuer || identity.expiresAt <= Date.now())
      throw new GateError("UNAUTHENTICATED");
    const r = this.rows(
      "SELECT p.id,p.grants_json FROM identities i JOIN principals p ON p.id=i.principal WHERE i.issuer=? AND i.key=? AND i.enabled=1 AND p.enabled=1",
      this.issuer,
      identity.key,
    )[0];
    if (!r) throw new GateError("UNAUTHENTICATED");
    return {
      tokenId: identity.key,
      principalId: String(r.id),
      revision: Number(
        this.rows("SELECT value FROM revision WHERE id=1")[0]!.value,
      ),
      allowed: selectWorkspaces(
        this.rows("SELECT id FROM workspaces ORDER BY id").map((r) =>
          String(r.id),
        ),
        JSON.parse(String(r.grants_json)) as Grants,
      ),
    };
  }
  workspace(id: string): Workspace {
    validateSlug(id);
    const r = this.rows("SELECT generation FROM workspaces WHERE id=?", id)[0];
    if (!r) throw new GateError("NOT_FOUND");
    return {
      id,
      generation: String(r.generation),
      backend: "openai",
      sources: [],
    };
  }
  snapshot(w: Workspace): OpenAISnapshot {
    const r = this.rows(
      "SELECT generation,parts,bytes,digest FROM workspaces WHERE id=?",
      w.id,
    )[0];
    if (!r || r.generation !== w.generation) throw new GateError("CONFLICT");
    const parts = Number(r.parts),
      bytes = Number(r.bytes);
    if (parts < 1 || parts > 16 || bytes > 9 * 1024 * 1024)
      throw new GateError("NOT_FOUND");
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    let index = 0;
    for (const row of this.storage.sql.exec(
      "SELECT part,payload FROM parts WHERE workspace=? ORDER BY part",
      w.id,
    )) {
      const chunk = new Uint8Array(row.payload as ArrayBuffer);
      if (
        Number(row.part) !== index++ ||
        chunk.length > CHUNK_BYTES ||
        offset + chunk.length > bytes
      )
        throw new GateError("NOT_FOUND");
      buffer.set(chunk, offset);
      offset += chunk.length;
    }
    if (
      index !== parts ||
      offset !== bytes ||
      createHash("sha256").update(buffer).digest("hex") !== r.digest
    )
      throw new GateError("NOT_FOUND");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(buffer),
    ) as OpenAISnapshot;
  }
  import(id: string, text: string, binding: OpenAIBinding): Workspace {
    return this.importPublication(
      id,
      parseManifest(text, binding),
      binding,
      false,
    );
  }
  // Only IngestionState calls this inside its journal/receipt transaction.
  importManaged(
    id: string,
    manifest: Manifest,
    binding: OpenAIBinding,
  ): Workspace {
    return this.importPublication(id, manifest, binding, true);
  }
  private importPublication(
    id: string,
    manifest: Manifest,
    binding: OpenAIBinding,
    managed: boolean,
  ): Workspace {
    validateSlug(id);
    const generation = manifestGeneration(manifest);
    this.storage.transactionSync(() => {
      const reservations = this.rows(
        "SELECT workspace FROM ingest_reservations WHERE workspace=?",
        id,
      );
      if (!managed && reservations.length) throw new GateError("CONFLICT");
      for (const store of Object.values(binding.stores)) {
        const reserved = this.rows(
          "SELECT workspace FROM ingest_reservations WHERE project=? AND store=?",
          binding.projectId,
          store,
        )[0];
        if (reserved && (!managed || reserved.workspace !== id))
          throw new GateError("CONFLICT");
      }
      const prior = this.rows(
        "SELECT prior_json FROM workspaces WHERE id=?",
        id,
      )[0];
      const seen = this.rows(
        "SELECT generation FROM publications WHERE workspace=? AND publication=?",
        id,
        manifest.publication_id,
      )[0];
      validatePublication(
        binding,
        manifest,
        generation,
        prior
          ? (JSON.parse(String(prior.prior_json)) as PriorPublication)
          : undefined,
        seen ? String(seen.generation) : undefined,
      );
      if (
        prior &&
        (JSON.parse(String(prior.prior_json)) as PriorPublication)
          .generation === generation
      )
        return;
      const bytes = new TextEncoder().encode(
        JSON.stringify({ ...binding, manifest }),
      );
      const count = Math.ceil(bytes.length / CHUNK_BYTES);
      this.storage.sql.exec("DELETE FROM parts WHERE workspace=?", id);
      for (let part = 0; part < count; part++)
        this.storage.sql.exec(
          "INSERT INTO parts VALUES(?,?,?)",
          id,
          part,
          bytes.slice(part * CHUNK_BYTES, (part + 1) * CHUNK_BYTES),
        );
      const meta: PriorPublication = {
        binding,
        sequence: manifest.generation,
        publication: manifest.publication_id,
        generation,
      };
      this.storage.sql.exec(
        "INSERT INTO workspaces VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,prior_json=excluded.prior_json,parts=excluded.parts,bytes=excluded.bytes,digest=excluded.digest",
        id,
        generation,
        JSON.stringify(meta),
        count,
        bytes.length,
        createHash("sha256").update(bytes).digest("hex"),
      );
      this.storage.sql.exec(
        "INSERT OR IGNORE INTO publications VALUES(?,?,?)",
        id,
        manifest.publication_id,
        generation,
      );
      this.bump();
    });
    return this.workspace(id);
  }
  inventory(
    kind: "workspaces" | "principals" | "identities",
    after: string,
    limit: number,
  ) {
    const queries = {
      workspaces:
        "SELECT id,generation,parts,bytes FROM workspaces WHERE id>? ORDER BY id LIMIT ?",
      principals:
        "SELECT id,enabled,grants_json FROM principals WHERE id>? ORDER BY id LIMIT ?",
      identities:
        "SELECT key AS id,principal,enabled FROM identities WHERE key>? ORDER BY key LIMIT ?",
    };
    const rows = this.rows(queries[kind], after, limit + 1);
    const items: typeof rows = [];
    let size = 1024;
    for (const row of rows.slice(0, limit)) {
      const bytes =
        new TextEncoder().encode(JSON.stringify(row)).byteLength + 1;
      if (size + bytes > 65536) break;
      items.push(row);
      size += bytes;
    }
    return {
      items,
      next: rows.length > items.length ? String(items.at(-1)!.id) : null,
    };
  }
}
