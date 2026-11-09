import type {
  DurableObjectStorage,
  SqlStorageValue,
} from "@cloudflare/workers-types/index.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonical, parseManifest, type OpenAIBinding } from "../manifest.js";
import {
  validateSlug,
  validateGrants,
  selectWorkspaces,
  type Grants,
} from "../policy.js";
import { validatePath } from "../gateway.js";
import { GateError, invalid } from "../errors.js";
import { validIdentityKey, type Identity } from "./access.js";
import type { CloudState } from "./state.js";
const number = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const slug = z
  .string()
  .max(80)
  .refine((v) => {
    try {
      validateSlug(v);
      return true;
    } catch {
      return false;
    }
  });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z.string().regex(/^[a-f0-9]{64}(?:\.retired\.[a-f0-9]{32})?$/);
const store = z.string().regex(/^vs_[A-Za-z0-9_-]{1,160}$/);
const plain = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x1f\x7f]+$/);
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
  })
  .strict();
export const provisionSchema = z
  .object({
    workspace: slug,
    enabled: z.boolean().default(true),
    binding: z
      .object({
        projectId: z.string().regex(/^proj_[A-Za-z0-9_-]{1,160}$/),
        credentialEnv: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]{0,127}$/)
          .refine((v) => !/ADMIN/i.test(v)),
        stores: z.record(slug, store),
      })
      .strict(),
    ownership: z
      .object({
        project_id: z.string(),
        collections: z.record(slug, collection),
      })
      .strict(),
  })
  .strict();
export const publisherSchema = z
  .object({
    key: z
      .string()
      .refine((v) => v.startsWith("service:") && validIdentityKey(v)),
    grants: z
      .object({
        allow: z.array(z.string()).max(100),
        deny: z.array(z.string()).max(100),
      })
      .strict(),
    enabled: z.boolean(),
  })
  .strict();
const proof = { epoch: number.refine((v) => v > 0), nonce: hash };
const command = { ...proof, expected_revision: number, request_id: z.uuid() };
export const leaseSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("acquire"), nonce: hash, request_id: z.uuid() })
    .strict(),
  z.object({ action: z.literal("renew"), ...proof }).strict(),
  z.object({ action: z.literal("release"), ...proof }).strict(),
]);
export const snapshotSchema = z.object({ ...proof, revision: number }).strict();
export const initializeSchema = z.object(command).strict();
export const operationSchema = z
  .object({
    collection: slug,
    store,
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((v) => {
        try {
          validatePath(v);
          return true;
        } catch {
          return false;
        }
      }),
    version: hash,
    sha256: hash,
    source_commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    filename: z.string().regex(/^wiki-rag-[a-f0-9]{32}\.(?:txt|pdf)$/),
    phase: z.enum([
      "upload_ready",
      "upload_pending",
      "uploaded",
      "attach_pending",
      "attached",
      "complete",
      "ingestion_failed",
      "detach_pending",
      "detached",
      "file_delete_pending",
      "deleted",
    ]),
    ingestion_attempts: z.number().int().min(1).max(3),
    file_id: z
      .string()
      .regex(/^file[-_][A-Za-z0-9_-]{1,160}$/)
      .optional(),
    terminal_failure: z.literal(true).optional(),
  })
  .strict()
  .refine((v) =>
    ["upload_ready", "upload_pending"].includes(v.phase)
      ? v.file_id === undefined
      : v.file_id !== undefined,
  )
  .refine((v) => Buffer.byteLength(JSON.stringify(v)) <= 8192);
export type Operation = z.infer<typeof operationSchema>;
export const checkpointSchema = z
  .object({
    ...command,
    upserts: z
      .array(z.object({ id: oid, operation: operationSchema }).strict())
      .max(100),
    retire: z
      .array(z.object({ id: hash, retired_id: oid }).strict())
      .max(50)
      .optional(),
  })
  .strict()
  .refine((v) => v.upserts.length + (v.retire?.length ?? 0) <= 100);
export const publishSchema = z
  .object({ ...command, manifestText: z.string() })
  .strict();
export const operationsSchema = z
  .object({
    ...proof,
    revision: number,
    ids: z.array(oid).min(1).max(50).optional(),
    after: z.union([oid, z.literal("")]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cleanup: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) =>
      !v.ids ||
      (v.after === undefined &&
        v.limit === undefined &&
        v.cleanup === undefined),
  );
function conflict(): never {
  throw new GateError("CONFLICT");
}
const digest = (v: string) => createHash("sha256").update(v).digest("hex");
const phases: Record<Operation["phase"], Operation["phase"][]> = {
  upload_ready: ["upload_pending"],
  upload_pending: ["upload_ready", "uploaded"],
  uploaded: ["attach_pending", "detach_pending"],
  attach_pending: ["uploaded", "attached"],
  attached: ["complete", "ingestion_failed", "detach_pending"],
  complete: ["detach_pending"],
  ingestion_failed: ["detach_pending"],
  detach_pending: ["detached"],
  detached: ["file_delete_pending"],
  file_delete_pending: ["deleted"],
  deleted: [],
};
export class IngestionState {
  constructor(
    private storage: DurableObjectStorage,
    private gate: CloudState,
  ) {
    storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS ingest_publishers(key TEXT PRIMARY KEY,grants_json TEXT NOT NULL,enabled INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS ingest_authorities(workspace TEXT PRIMARY KEY,binding_json TEXT NOT NULL,ownership_json TEXT NOT NULL,initialized INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,epoch INTEGER NOT NULL DEFAULT 0,lease_owner TEXT,lease_hash TEXT,lease_request TEXT,lease_expires INTEGER NOT NULL DEFAULT 0,operation_count INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS ingest_operations(workspace TEXT NOT NULL,id TEXT NOT NULL,operation_json TEXT NOT NULL,phase TEXT NOT NULL,file_id TEXT,PRIMARY KEY(workspace,id));
 CREATE TABLE IF NOT EXISTS ingest_uploads(project TEXT NOT NULL,filename TEXT NOT NULL,PRIMARY KEY(project,filename));
 CREATE TABLE IF NOT EXISTS ingest_files(project TEXT NOT NULL,file_id TEXT NOT NULL,workspace TEXT NOT NULL,operation_id TEXT NOT NULL,PRIMARY KEY(project,file_id));
 CREATE TABLE IF NOT EXISTS ingest_active(workspace TEXT NOT NULL,id TEXT NOT NULL,file_id TEXT NOT NULL,PRIMARY KEY(workspace,id));
 CREATE TABLE IF NOT EXISTS ingest_receipts(workspace TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,result_json TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(workspace,request_id));`);
  }
  private rows(q: string, ...a: SqlStorageValue[]) {
    return this.storage.sql.exec(q, ...a).toArray();
  }
  private authority(w: string) {
    const r = this.rows(
      "SELECT * FROM ingest_authorities WHERE workspace=?",
      w,
    )[0];
    if (!r) throw new GateError("NOT_FOUND");
    return r;
  }
  private permits(key: string, w: string) {
    const p = this.rows(
      "SELECT * FROM ingest_publishers WHERE key=? AND enabled=1",
      key,
    )[0];
    return (
      !!p &&
      selectWorkspaces([w], JSON.parse(String(p.grants_json)) as Grants)
        .length === 1
    );
  }
  authorize(identity: Identity, w: string) {
    validateSlug(w);
    this.gate.checkAuthority();
    if (
      identity.issuer !== this.gate.issuer ||
      identity.expiresAt <= Date.now()
    )
      throw new GateError("UNAUTHENTICATED");
    if (!identity.key.startsWith("service:") || !this.permits(identity.key, w))
      throw new GateError("ACCESS_DENIED");
    if (!this.authority(w).enabled) throw new GateError("ACCESS_DENIED");
  }
  setPublisher(value: unknown) {
    const v = publisherSchema.parse(value);
    validateGrants(v.grants);
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "INSERT INTO ingest_publishers VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET grants_json=excluded.grants_json,enabled=excluded.enabled",
        v.key,
        JSON.stringify(v.grants),
        +v.enabled,
      );
      for (const r of this.storage.sql.exec(
        "SELECT workspace FROM ingest_authorities WHERE lease_owner=?",
        v.key,
      ))
        if (!this.permits(v.key, String(r.workspace)))
          this.storage.sql.exec(
            "UPDATE ingest_authorities SET lease_expires=0 WHERE workspace=?",
            r.workspace,
          );
    });
  }
  provision(value: unknown) {
    const v = provisionSchema.parse(value),
      names = Object.keys(v.ownership.collections);
    if (
      names.length < 1 ||
      names.length > 20 ||
      v.ownership.project_id !== v.binding.projectId ||
      canonical(
        Object.fromEntries(
          Object.entries(v.ownership.collections).map(([n, c]) => [
            n,
            c.vector_store_id,
          ]),
        ),
      ) !== canonical(v.binding.stores) ||
      new Set(Object.values(v.binding.stores)).size !== names.length
    )
      invalid();
    this.storage.transactionSync(() => {
      const existing = this.rows(
        "SELECT binding_json,ownership_json FROM ingest_authorities WHERE workspace=?",
        v.workspace,
      )[0];
      if (existing) {
        if (
          existing.binding_json !== canonical(v.binding) ||
          existing.ownership_json !== canonical(v.ownership)
        )
          conflict();
        this.storage.sql.exec(
          "UPDATE ingest_authorities SET enabled=?,lease_expires=CASE WHEN ?=0 THEN 0 ELSE lease_expires END WHERE workspace=?",
          +v.enabled,
          +v.enabled,
          v.workspace,
        );
        return;
      }
      if (this.rows("SELECT id FROM workspaces WHERE id=?", v.workspace).length)
        conflict();
      for (const s of Object.values(v.binding.stores)) {
        if (
          this.rows(
            "SELECT workspace FROM ingest_reservations WHERE project=? AND store=?",
            v.binding.projectId,
            s,
          ).length
        )
          conflict();
        if (
          this.rows(
            "SELECT w.id FROM workspaces w,json_each(w.prior_json,'$.binding.stores') s WHERE json_extract(w.prior_json,'$.binding.projectId')=? AND s.value=? LIMIT 1",
            v.binding.projectId,
            s,
          ).length
        )
          conflict();
      }
      this.storage.sql.exec(
        "INSERT INTO ingest_authorities(workspace,binding_json,ownership_json,enabled) VALUES(?,?,?,?)",
        v.workspace,
        canonical(v.binding),
        canonical(v.ownership),
        +v.enabled,
      );
      for (const s of Object.values(v.binding.stores))
        this.storage.sql.exec(
          "INSERT INTO ingest_reservations VALUES(?,?,?)",
          v.binding.projectId,
          s,
          v.workspace,
        );
    });
  }
  private held(w: string, i: Identity, p: { epoch: number; nonce: string }) {
    this.authorize(i, w);
    const a = this.authority(w);
    if (
      a.epoch !== p.epoch ||
      a.lease_owner !== i.key ||
      a.lease_hash !== digest(p.nonce) ||
      Number(a.lease_expires) <= Date.now()
    )
      conflict();
    return a;
  }
  lease(w: string, i: Identity, value: unknown) {
    const v = leaseSchema.parse(value);
    return this.storage.transactionSync(() => {
      this.authorize(i, w);
      const a = this.authority(w),
        now = Date.now();
      if (v.action === "acquire") {
        if (
          Number(a.lease_expires) > now &&
          this.permits(String(a.lease_owner), w)
        ) {
          if (
            a.lease_owner === i.key &&
            a.lease_hash === digest(v.nonce) &&
            a.lease_request === v.request_id
          )
            return {
              epoch: Number(a.epoch),
              expires_at: Number(a.lease_expires),
              server_time: now,
            };
          conflict();
        }
        if (Number(a.epoch) >= Number.MAX_SAFE_INTEGER) conflict();
        const epoch = Number(a.epoch) + 1,
          expires = now + 120000;
        this.storage.sql.exec(
          "UPDATE ingest_authorities SET epoch=?,lease_owner=?,lease_hash=?,lease_request=?,lease_expires=? WHERE workspace=?",
          epoch,
          i.key,
          digest(v.nonce),
          v.request_id,
          expires,
          w,
        );
        return { epoch, expires_at: expires, server_time: now };
      }
      this.held(w, i, v);
      const expires = v.action === "renew" ? now + 120000 : 0;
      this.storage.sql.exec(
        "UPDATE ingest_authorities SET lease_expires=? WHERE workspace=?",
        expires,
        w,
      );
      return { epoch: v.epoch, expires_at: expires, server_time: now };
    });
  }
  publication(w: string, generation?: string, part?: number) {
    const row = this.rows(
      "SELECT generation,parts,bytes,digest FROM workspaces WHERE id=?",
      w,
    )[0];
    if (generation !== undefined) {
      if (!row || generation !== row.generation) conflict();
      if (part === undefined || part < 0 || part >= Number(row.parts))
        invalid();
      const r = this.rows(
        "SELECT payload FROM parts WHERE workspace=? AND part=?",
        w,
        part,
      )[0];
      if (!r) throw new GateError("NOT_FOUND");
      return new Response(r.payload as ArrayBuffer, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "no-store",
        },
      });
    }
    return row
      ? {
          generation: String(row.generation),
          parts: Number(row.parts),
          bytes: Number(row.bytes),
          digest: String(row.digest),
        }
      : null;
  }
  status(w: string) {
    const a = this.authority(w);
    return {
      workspace: w,
      initialized: !!a.initialized,
      revision: Number(a.revision),
      binding: JSON.parse(String(a.binding_json)),
      ownership: JSON.parse(String(a.ownership_json)),
      publication: this.publication(w),
      operation_count: Number(a.operation_count),
    };
  }
  snapshot(w: string, i: Identity, value: unknown) {
    const v = snapshotSchema.parse(value),
      a = this.held(w, i, v);
    if (a.revision !== v.revision) conflict();
    return this.status(w);
  }
  operations(w: string, i: Identity, value: unknown) {
    const v = operationsSchema.parse(value),
      a = this.held(w, i, v);
    if (a.revision !== v.revision) conflict();
    const ids = v.ids ? [...new Set(v.ids)].sort() : undefined;
    const rows = ids
      ? this.storage.sql.exec(
          `SELECT id,operation_json FROM ingest_operations WHERE workspace=? AND id IN (${ids.map(() => "?").join(",")}) ORDER BY id`,
          w,
          ...ids,
        )
      : this.storage.sql.exec(
          `SELECT id,operation_json FROM ingest_operations o WHERE workspace=? AND id>? ${v.cleanup ? "AND phase!='deleted' AND NOT EXISTS(SELECT 1 FROM ingest_active a WHERE a.workspace=o.workspace AND a.id=o.id)" : ""} ORDER BY id LIMIT ?`,
          w,
          v.after ?? "",
          (v.limit ?? 100) + 1,
        );
    const items: { id: string; operation: Operation }[] = [];
    let size = 1024,
      next: string | null = null;
    for (const row of rows) {
      const item = {
          id: String(row.id),
          operation: JSON.parse(String(row.operation_json)) as Operation,
        },
        bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (items.length >= (v.limit ?? 100) || size + bytes > 512 * 1024) {
        next = items.at(-1)!.id;
        break;
      }
      items.push(item);
      size += bytes;
    }
    return { revision: v.revision, items, next };
  }
  private commit(
    w: string,
    i: Identity,
    v: z.infer<typeof initializeSchema>,
    kind: string,
    value: unknown,
    effect: () => Record<string, unknown>,
  ) {
    return this.storage.transactionSync(() => {
      const a = this.held(w, i, v),
        d = digest(kind + "\n" + canonical(value));
      const r = this.rows(
        "SELECT * FROM ingest_receipts WHERE workspace=? AND request_id=?",
        w,
        v.request_id,
      )[0];
      if (r) {
        if (r.digest !== d) conflict();
        return JSON.parse(String(r.result_json)) as Record<string, unknown>;
      }
      if (
        a.revision !== v.expected_revision ||
        v.expected_revision >= Number.MAX_SAFE_INTEGER
      )
        conflict();
      const result = { ...effect(), revision: v.expected_revision + 1 };
      this.storage.sql.exec(
        "UPDATE ingest_authorities SET revision=? WHERE workspace=?",
        result.revision,
        w,
      );
      this.storage.sql.exec(
        "INSERT INTO ingest_receipts VALUES(?,?,?,?,?)",
        w,
        v.request_id,
        d,
        JSON.stringify(result),
        result.revision,
      );
      this.storage.sql.exec(
        "DELETE FROM ingest_receipts WHERE workspace=? AND revision<=?",
        w,
        result.revision - 256,
      );
      return result;
    });
  }
  initialize(w: string, i: Identity, value: unknown) {
    const v = initializeSchema.parse(value);
    return this.commit(w, i, v, "initialize", v, () => {
      this.storage.sql.exec(
        "UPDATE ingest_authorities SET initialized=1 WHERE workspace=?",
        w,
      );
      return { initialized: true };
    });
  }
  checkpoint(w: string, i: Identity, value: unknown) {
    const v = checkpointSchema.parse(value);
    return this.commit(w, i, v, "checkpoint", v, () => {
      const a = this.authority(w);
      if (!a.initialized) conflict();
      const ownership = JSON.parse(String(a.ownership_json)) as z.infer<
        typeof provisionSchema
      >["ownership"];
      let count = Number(a.operation_count);
      const ids = new Set<string>();
      for (const u of v.upserts) {
        if (ids.has(u.id)) invalid();
        ids.add(u.id);
      }
      const retired = new Map<string, Operation>();
      for (const r of v.retire ?? []) {
        if (
          retired.has(r.id) ||
          !r.retired_id.startsWith(r.id + ".retired.") ||
          ids.has(r.retired_id) ||
          !ids.has(r.id)
        )
          invalid();

        const old = this.rows(
          "SELECT * FROM ingest_operations WHERE workspace=? AND id=?",
          w,
          r.id,
        )[0];
        if (
          !old ||
          old.phase !== "deleted" ||
          this.rows(
            "SELECT id FROM ingest_operations WHERE workspace=? AND id=?",
            w,
            r.retired_id,
          ).length
        )
          conflict();
        retired.set(r.id, JSON.parse(String(old.operation_json)) as Operation);
        this.storage.sql.exec(
          "INSERT INTO ingest_operations VALUES(?,?,?,?,?)",
          w,
          r.retired_id,
          old.operation_json,
          old.phase,
          old.file_id,
        );
        this.storage.sql.exec(
          "DELETE FROM ingest_operations WHERE workspace=? AND id=?",
          w,
          r.id,
        );
        count++;
        if (old.file_id)
          this.storage.sql.exec(
            "UPDATE ingest_files SET operation_id=? WHERE project=? AND file_id=?",
            r.retired_id,
            ownership.project_id,
            old.file_id,
          );
      }
      for (const { id, operation: o } of v.upserts) {
        const c = ownership.collections[o.collection];
        if (!c || c.vector_store_id !== o.store) invalid();
        const row = this.rows(
            "SELECT operation_json FROM ingest_operations WHERE workspace=? AND id=?",
            w,
            id,
          )[0],
          old = row
            ? (JSON.parse(String(row.operation_json)) as Operation)
            : undefined;
        if (!old) {
          if (
            id.includes(".retired.") ||
            o.phase !== "upload_ready" ||
            o.terminal_failure
          )
            conflict();
          const previous = retired.get(id);
          const attempts = previous?.terminal_failure
            ? previous.ingestion_attempts + 1
            : 1;
          if (
            o.ingestion_attempts !== attempts ||
            this.rows(
              "SELECT filename FROM ingest_uploads WHERE project=? AND filename=?",
              ownership.project_id,
              o.filename,
            ).length
          )
            conflict();
          this.storage.sql.exec(
            "INSERT INTO ingest_uploads VALUES(?,?)",
            ownership.project_id,
            o.filename,
          );
          if (!retired.has(id)) count++;
        } else {
          const immutable = (x: Operation) => {
            const { phase, file_id, terminal_failure, ...rest } = x;
            return rest;
          };
          if (
            canonical(immutable(old)) !== canonical(immutable(o)) ||
            (old.file_id !== undefined && old.file_id !== o.file_id) ||
            (old.terminal_failure && !o.terminal_failure) ||
            (old.phase !== o.phase && !phases[old.phase].includes(o.phase))
          )
            conflict();
          if (
            o.terminal_failure &&
            !old.terminal_failure &&
            o.phase !== "ingestion_failed"
          )
            conflict();
        }
        if (o.file_id) {
          const active = this.rows(
            "SELECT id FROM ingest_active WHERE workspace=? AND file_id=?",
            w,
            o.file_id,
          )[0];
          if (active && o.phase !== "complete") conflict();
          const owner = this.rows(
            "SELECT workspace,operation_id FROM ingest_files WHERE project=? AND file_id=?",
            ownership.project_id,
            o.file_id,
          )[0];
          if (owner && (owner.workspace !== w || owner.operation_id !== id))
            conflict();
          this.storage.sql.exec(
            "INSERT OR IGNORE INTO ingest_files VALUES(?,?,?,?)",
            ownership.project_id,
            o.file_id,
            w,
            id,
          );
        }
        this.storage.sql.exec(
          "INSERT INTO ingest_operations VALUES(?,?,?,?,?) ON CONFLICT(workspace,id) DO UPDATE SET operation_json=excluded.operation_json,phase=excluded.phase,file_id=excluded.file_id",
          w,
          id,
          JSON.stringify(o),
          o.phase,
          o.file_id ?? null,
        );
      }
      if (count > 100000) conflict();
      this.storage.sql.exec(
        "UPDATE ingest_authorities SET operation_count=? WHERE workspace=?",
        count,
        w,
      );
      return {};
    });
  }
  publish(w: string, i: Identity, value: unknown) {
    const v = publishSchema.parse(value);
    return this.commit(w, i, v, "publish", v, () => {
      const a = this.authority(w);
      if (!a.initialized) conflict();
      const binding = JSON.parse(String(a.binding_json)) as OpenAIBinding,
        ownership = JSON.parse(String(a.ownership_json)) as z.infer<
          typeof provisionSchema
        >["ownership"],
        manifest = parseManifest(v.manifestText, binding);
      for (const [name, c] of Object.entries(manifest.collections)) {
        const expected = ownership.collections[name];
        if (
          !expected ||
          expected.repository !== c.repository ||
          expected.branch !== c.branch ||
          c.repository_commit === null
        )
          invalid();
        for (const f of Object.values(c.files)) {
          const row = this.rows(
            "SELECT operation_json FROM ingest_operations WHERE workspace=? AND id=?",
            w,
            f.operation_id,
          )[0];
          if (!row) conflict();
          const o = JSON.parse(String(row.operation_json)) as Operation;
          if (
            o.phase !== "complete" ||
            o.collection !== name ||
            o.store !== f.vector_store_id ||
            o.path !== f.path ||
            o.version !== f.version ||
            o.sha256 !== f.sha256 ||
            o.file_id !== f.file_id ||
            o.source_commit !== f.source_commit ||
            f.operation_id.includes(".retired.")
          )
            conflict();
        }
      }
      const published = this.gate.importManaged(w, manifest, binding);
      this.storage.sql.exec("DELETE FROM ingest_active WHERE workspace=?", w);
      for (const c of Object.values(manifest.collections))
        for (const f of Object.values(c.files))
          this.storage.sql.exec(
            "INSERT INTO ingest_active VALUES(?,?,?)",
            w,
            f.operation_id,
            f.file_id,
          );
      return { generation: published.generation };
    });
  }
}
