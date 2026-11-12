import type {
  DurableObjectStorage,
  SqlStorageValue,
} from "@cloudflare/workers-types/index.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonical,
  parseManifest,
  sourceOriginSchema,
  type Manifest,
  type OpenAIBinding,
} from "../manifest.js";
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
    origin: sourceOriginSchema.optional(),
  })
  .strict()
  .refine(
    (v) =>
      !v.origin || v.origin.kind !== "git-lfs" || v.origin.oid === v.sha256,
  )
  .refine((v) =>
    ["upload_ready", "upload_pending"].includes(v.phase)
      ? v.file_id === undefined
      : v.file_id !== undefined,
  )
  .refine((v) => Buffer.byteLength(JSON.stringify(v)) <= 8192);
export type Operation = z.infer<typeof operationSchema>;
export interface BackgroundJob {
  workspace: string;
  id: string;
  owner: string;
  epoch: number;
  revision: number;
  binding: OpenAIBinding;
  store: string;
  storeIndex: number;
  after: string | null;
  cursors: string[];
  attempts: number;
}
export interface ProviderFilePage {
  data: Array<{
    id: string;
    vector_store_id?: unknown;
    status: string;
    attributes?: Record<string, unknown> | null;
    last_error?: { code?: unknown } | null;
    usage_bytes?: unknown;
  }>;
  has_more: boolean;
  last_id?: string | null;
}
export interface JobDiagnostics {
  stage: "finalize_attachment";
  operation_id: string;
  attachment_status: string;
  metadata_state: "matching" | "absent" | "empty" | "missing" | "conflict";
  metadata_field?: string;
  provider_error_code?: string;
  usage_bytes?: number;
}
export class BackgroundFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly fileId?: string,
    public readonly diagnostics?: JobDiagnostics,
  ) {
    super(code);
  }
}
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
 CREATE TABLE IF NOT EXISTS ingest_receipts(workspace TEXT NOT NULL,request_id TEXT NOT NULL,digest TEXT NOT NULL,result_json TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(workspace,request_id));
 CREATE TABLE IF NOT EXISTS ingest_jobs(workspace TEXT PRIMARY KEY,id TEXT NOT NULL,status TEXT NOT NULL,owner TEXT NOT NULL,epoch INTEGER NOT NULL,revision INTEGER NOT NULL,manifest_json TEXT NOT NULL,binding_json TEXT NOT NULL,created_at INTEGER NOT NULL,next_at INTEGER NOT NULL,total INTEGER NOT NULL,completed INTEGER NOT NULL,store_index INTEGER NOT NULL DEFAULT 0,cursor TEXT,cursors_json TEXT NOT NULL DEFAULT '[]',attempts INTEGER NOT NULL DEFAULT 0,error TEXT,publication_id TEXT);
 CREATE TABLE IF NOT EXISTS ingest_job_files(workspace TEXT NOT NULL,file_id TEXT NOT NULL,operation_id TEXT NOT NULL,store TEXT NOT NULL,attributes_json TEXT NOT NULL,ready INTEGER NOT NULL,PRIMARY KEY(workspace,file_id));`);
    if (
      !this.rows("PRAGMA table_info(ingest_jobs)").some(
        (r) => r.name === "finished_at",
      )
    )
      this.storage.sql.exec(
        "ALTER TABLE ingest_jobs ADD COLUMN finished_at INTEGER",
      );
    if (
      !this.rows("PRAGMA table_info(ingest_jobs)").some(
        (r) => r.name === "diagnostics_json",
      )
    )
      this.storage.sql.exec(
        "ALTER TABLE ingest_jobs ADD COLUMN diagnostics_json TEXT",
      );
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
      for (const r of this.rows(
        "SELECT workspace FROM ingest_jobs WHERE owner=? AND status='pending'",
        v.key,
      ))
        if (!this.permits(v.key, String(r.workspace)))
          this.invalidateJob(String(r.workspace), "revoked");
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
        if (!v.enabled) this.invalidateJob(v.workspace, "revoked");
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
        this.invalidateJob(w, "superseded");
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
      features: ["async-submit-v1", "file-origin-v1"],
      job: this.jobStatus(w),
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
      if (kind !== "submit") this.invalidateJob(w, "superseded");
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
  private validatedManifest(
    w: string,
    text: string,
    allowed: Operation["phase"][],
  ) {
    const a = this.authority(w);
    if (!a.initialized) conflict();
    const binding = JSON.parse(String(a.binding_json)) as OpenAIBinding,
      ownership = JSON.parse(String(a.ownership_json)) as z.infer<
        typeof provisionSchema
      >["ownership"],
      manifest = parseManifest(text, binding);
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
          !allowed.includes(o.phase) ||
          o.collection !== name ||
          o.store !== f.vector_store_id ||
          o.path !== f.path ||
          o.version !== f.version ||
          o.sha256 !== f.sha256 ||
          o.file_id !== f.file_id ||
          o.source_commit !== f.source_commit ||
          canonical(o.origin ?? null) !== canonical(f.origin ?? null) ||
          f.operation_id.includes(".retired.")
        )
          conflict();
      }
    }
    this.gate.validateManaged(w, manifest, binding);
    return { manifest, binding, ownership };
  }
  private installPublication(
    w: string,
    manifest: Manifest,
    binding: OpenAIBinding,
  ) {
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
  }
  publish(w: string, i: Identity, value: unknown) {
    const v = publishSchema.parse(value);
    return this.commit(w, i, v, "publish", v, () => {
      const { manifest, binding } = this.validatedManifest(w, v.manifestText, [
        "complete",
      ]);
      return this.installPublication(w, manifest, binding);
    });
  }

  private invalidateJob(w: string, status: "revoked" | "superseded") {
    this.storage.sql.exec(
      "UPDATE ingest_jobs SET status=?,next_at=0,finished_at=? WHERE workspace=? AND status='pending'",
      status,
      Date.now(),
      w,
    );
  }
  jobStatus(w: string) {
    const r = this.rows(
      "SELECT id,status,total,completed,error,publication_id,created_at,finished_at,diagnostics_json FROM ingest_jobs WHERE workspace=?",
      w,
    )[0];
    if (!r) return null;
    const finished = r.finished_at === null ? null : Number(r.finished_at);
    return {
      id: String(r.id),
      status: String(r.status),
      total: Number(r.total),
      completed: Number(r.completed),
      created_at: Number(r.created_at),
      finished_at: finished,
      duration_ms: finished === null ? null : finished - Number(r.created_at),
      ...(r.error ? { error: String(r.error) } : {}),
      ...(r.diagnostics_json
        ? {
            diagnostics: JSON.parse(
              String(r.diagnostics_json),
            ) as JobDiagnostics,
          }
        : {}),
      ...(r.publication_id ? { publication_id: String(r.publication_id) } : {}),
    };
  }
  submit(w: string, i: Identity, value: unknown) {
    const v = publishSchema.parse(value);
    return this.commit(w, i, v, "submit", v, () => {
      const { manifest, binding, ownership } = this.validatedManifest(
        w,
        v.manifestText,
        ["attached", "complete"],
      );
      const id = crypto.randomUUID(),
        now = Date.now();
      this.storage.sql.exec(
        "DELETE FROM ingest_job_files WHERE workspace=?",
        w,
      );
      let total = 0,
        completed = 0;
      for (const [name, c] of Object.entries(manifest.collections))
        for (const f of Object.values(c.files)) {
          const row = this.rows(
            "SELECT phase FROM ingest_operations WHERE workspace=? AND id=?",
            w,
            f.operation_id,
          )[0]!;
          const ready = Number(row.phase === "complete");
          total++;
          completed += ready;
          const attributes = {
            repository: ownership.collections[name]!.repository,
            path: f.path,
            commit: f.source_commit,
            kind: f.kind,
            collection: name,
            branch: ownership.collections[name]!.branch ?? "unspecified",
            sha256: f.sha256,
            operation_id: f.operation_id,
            ...(f.origin ? { source_kind: f.origin.kind } : {}),
          };
          this.storage.sql.exec(
            "INSERT INTO ingest_job_files VALUES(?,?,?,?,?,?)",
            w,
            f.file_id,
            f.operation_id,
            f.vector_store_id,
            canonical(attributes),
            ready,
          );
        }
      this.storage.sql.exec(
        `INSERT OR REPLACE INTO ingest_jobs(workspace,id,status,owner,epoch,revision,manifest_json,binding_json,created_at,next_at,total,completed)
        VALUES(?,?,'pending',?,?,?,?,?,?,?,?,?)`,
        w,
        id,
        i.key,
        v.epoch,
        v.expected_revision + 1,
        v.manifestText,
        canonical(binding),
        now,
        now,
        total,
        completed,
      );
      return { job_id: id };
    });
  }
  nextJobTime(): number | null {
    const r = this.rows(
      "SELECT MIN(next_at) AS next FROM ingest_jobs WHERE status='pending'",
    )[0];
    return r?.next === null || r?.next === undefined ? null : Number(r.next);
  }
  private validJob(job: BackgroundJob) {
    this.gate.checkAuthority();
    const r = this.rows(
      "SELECT * FROM ingest_jobs WHERE workspace=?",
      job.workspace,
    )[0];
    if (
      !r ||
      r.id !== job.id ||
      r.status !== "pending" ||
      r.epoch !== job.epoch ||
      r.revision !== job.revision
    )
      return null;
    const a = this.authority(job.workspace);
    if (!a.enabled || !this.permits(String(r.owner), job.workspace)) {
      this.invalidateJob(job.workspace, "revoked");
      return null;
    }
    if (
      a.epoch !== job.epoch ||
      a.revision !== job.revision ||
      a.binding_json !== r.binding_json
    ) {
      this.invalidateJob(job.workspace, "superseded");
      return null;
    }
    if (Number(a.lease_expires) > Date.now()) return null;
    return r;
  }
  dueJob(): BackgroundJob | null {
    return this.storage.transactionSync(() => {
      this.gate.checkAuthority();
      const r = this.rows(
        "SELECT * FROM ingest_jobs WHERE status='pending' AND next_at<=? ORDER BY next_at,workspace LIMIT 1",
        Date.now(),
      )[0];
      if (!r) return null;
      const w = String(r.workspace),
        a = this.authority(w);
      if (!a.enabled || !this.permits(String(r.owner), w)) {
        this.invalidateJob(w, "revoked");
        return null;
      }
      if (
        a.epoch !== r.epoch ||
        a.revision !== r.revision ||
        a.binding_json !== r.binding_json
      ) {
        this.invalidateJob(w, "superseded");
        return null;
      }
      if (Number(r.created_at) + 86400000 <= Date.now()) {
        this.storage.sql.exec(
          "UPDATE ingest_jobs SET status='failed',error='finalization_timeout',next_at=0,finished_at=? WHERE workspace=?",
          Date.now(),
          w,
        );
        return null;
      }
      if (Number(a.lease_expires) > Date.now()) {
        this.storage.sql.exec(
          "UPDATE ingest_jobs SET next_at=? WHERE workspace=?",
          Math.min(Number(a.lease_expires) + 1, Date.now() + 5000),
          w,
        );
        return null;
      }
      const binding = JSON.parse(String(r.binding_json)) as OpenAIBinding;
      const stores = Object.keys(binding.stores)
        .sort()
        .map((k) => binding.stores[k]!);
      let index = Number(r.store_index),
        after = r.cursor === null ? null : String(r.cursor),
        cursors = JSON.parse(String(r.cursors_json)) as string[];
      for (let n = 0; n < stores.length; n++) {
        if (
          this.rows(
            "SELECT 1 FROM ingest_job_files WHERE workspace=? AND store=? AND ready=0 LIMIT 1",
            w,
            stores[index]!,
          )[0]
        )
          break;
        index = (index + 1) % stores.length;
        after = null;
        cursors = [];
      }
      return {
        workspace: w,
        id: String(r.id),
        owner: String(r.owner),
        epoch: Number(r.epoch),
        revision: Number(r.revision),
        binding,
        store: stores[index]!,
        storeIndex: index,
        after,
        cursors,
        attempts: Number(r.attempts),
      };
    });
  }
  completeReadyJob(job: BackgroundJob): boolean {
    return this.storage.transactionSync(() => {
      const r = this.validJob(job);
      if (!r) return true;
      if (
        this.rows(
          "SELECT 1 FROM ingest_job_files WHERE workspace=? AND ready=0 LIMIT 1",
          job.workspace,
        )[0]
      )
        return false;
      this.finishJob(job, String(r.manifest_json));
      return true;
    });
  }
  private finishJob(job: BackgroundJob, text: string) {
    const { manifest, binding } = this.validatedManifest(job.workspace, text, [
      "attached",
      "complete",
    ]);
    for (const c of Object.values(manifest.collections))
      for (const f of Object.values(c.files)) {
        const row = this.rows(
          "SELECT operation_json FROM ingest_operations WHERE workspace=? AND id=?",
          job.workspace,
          f.operation_id,
        )[0]!;
        const operation = JSON.parse(String(row.operation_json)) as Operation;
        if (operation.phase === "attached") {
          operation.phase = "complete";
          this.storage.sql.exec(
            "UPDATE ingest_operations SET phase='complete',operation_json=? WHERE workspace=? AND id=?",
            JSON.stringify(operation),
            job.workspace,
            f.operation_id,
          );
        }
      }
    this.installPublication(job.workspace, manifest, binding);
    this.storage.sql.exec(
      "UPDATE ingest_authorities SET revision=revision+1 WHERE workspace=?",
      job.workspace,
    );
    this.storage.sql.exec(
      "UPDATE ingest_jobs SET status='complete',completed=total,publication_id=?,revision=revision+1,next_at=0,error=NULL,manifest_json='',finished_at=? WHERE workspace=?",
      manifest.publication_id,
      Date.now(),
      job.workspace,
    );
    this.storage.sql.exec(
      "DELETE FROM ingest_job_files WHERE workspace=?",
      job.workspace,
    );
  }
  applyJobPage(job: BackgroundJob, page: ProviderFilePage) {
    this.storage.transactionSync(() => {
      const r = this.validJob(job);
      if (!r) return;
      for (const f of page.data) {
        const expected = this.rows(
          "SELECT * FROM ingest_job_files WHERE workspace=? AND file_id=?",
          job.workspace,
          f.id,
        )[0];
        if (!expected || expected.ready) continue;
        const attributes = JSON.parse(
          String(expected.attributes_json),
        ) as Record<string, unknown>;
        if (expected.store !== job.store || f.vector_store_id !== job.store)
          throw new BackgroundFailure("provider_metadata_store");
        // In-progress provider records may not expose final attributes yet.
        // They cannot become ready until a later completed record passes every check.
        if (f.status === "in_progress") continue;
        const mismatch = Object.entries(attributes).find(
          ([k, v]) => f.attributes?.[k] !== v,
        );
        const absent = f.attributes == null;
        const empty =
          !absent &&
          typeof f.attributes === "object" &&
          !Array.isArray(f.attributes) &&
          Object.keys(f.attributes!).length === 0;
        const diagnostics: JobDiagnostics = {
          stage: "finalize_attachment",
          operation_id: String(expected.operation_id),
          attachment_status: f.status,
          metadata_state: absent
            ? "absent"
            : empty
              ? "empty"
              : mismatch
                ? Object.hasOwn(f.attributes!, mismatch[0])
                  ? "conflict"
                  : "missing"
                : "matching",
          ...(!absent && !empty && mismatch
            ? { metadata_field: mismatch[0] }
            : {}),
        };
        if (f.last_error?.code !== undefined)
          diagnostics.provider_error_code = [
            "server_error",
            "unsupported_file",
            "invalid_file",
          ].includes(String(f.last_error.code))
            ? String(f.last_error.code)
            : "unrecognized";
        if (
          typeof f.usage_bytes === "number" &&
          Number.isSafeInteger(f.usage_bytes) &&
          f.usage_bytes >= 0
        )
          diagnostics.usage_bytes = f.usage_bytes;
        // A terminal owned file cannot publish. Empty metadata must not hide its
        // terminal state, but nonempty conflicts still forbid automatic retirement.
        if (
          (f.status === "failed" || f.status === "cancelled") &&
          (absent || empty || !mismatch)
        )
          throw new BackgroundFailure("ingestion_failed", f.id, diagnostics);
        if (absent)
          throw new BackgroundFailure(
            `provider_metadata_absent_${f.status}`,
            undefined,
            diagnostics,
          );
        if (mismatch)
          throw new BackgroundFailure(
            `provider_metadata_${mismatch[0]}_${f.status}`,
            undefined,
            diagnostics,
          );
        if (f.status === "completed")
          this.storage.sql.exec(
            "UPDATE ingest_job_files SET ready=1 WHERE workspace=? AND file_id=?",
            job.workspace,
            f.id,
          );
      }
      const completed = Number(
        this.rows(
          "SELECT COUNT(*) AS n FROM ingest_job_files WHERE workspace=? AND ready=1",
          job.workspace,
        )[0]!.n,
      );
      if (completed === Number(r.total)) {
        this.finishJob(job, String(r.manifest_json));
        return;
      }
      const stores = Object.keys(job.binding.stores).length;
      const next = page.has_more ? page.last_id! : null;
      if (
        next &&
        (next === job.after ||
          job.cursors.includes(next) ||
          job.cursors.length >= 1000)
      )
        throw new BackgroundFailure("provider_pagination");
      this.storage.sql.exec(
        "UPDATE ingest_authorities SET revision=revision+1 WHERE workspace=?",
        job.workspace,
      );
      this.storage.sql.exec(
        "UPDATE ingest_jobs SET revision=revision+1,completed=?,store_index=?,cursor=?,cursors_json=?,next_at=?,attempts=0,error=NULL WHERE workspace=?",
        completed,
        page.has_more ? job.storeIndex : (job.storeIndex + 1) % stores,
        next,
        JSON.stringify(next ? [...job.cursors, next] : []),
        Date.now() + (page.has_more ? 1000 : 30000),
        job.workspace,
      );
    });
  }
  failJob(
    job: BackgroundJob,
    code: string,
    retry: boolean,
    fileId?: string,
    diagnostics?: JobDiagnostics,
  ) {
    this.storage.transactionSync(() => {
      if (!this.validJob(job)) return;
      if (fileId) {
        const owned = this.rows(
          "SELECT operation_id FROM ingest_job_files WHERE workspace=? AND file_id=?",
          job.workspace,
          fileId,
        )[0];
        if (owned) {
          const row = this.rows(
            "SELECT operation_json FROM ingest_operations WHERE workspace=? AND id=?",
            job.workspace,
            owned.operation_id!,
          )[0]!;
          const operation = JSON.parse(String(row.operation_json)) as Operation;
          if (operation.phase === "attached") {
            operation.phase = "ingestion_failed";
            operation.terminal_failure = true;
            this.storage.sql.exec(
              "UPDATE ingest_operations SET phase=?,operation_json=? WHERE workspace=? AND id=?",
              operation.phase,
              JSON.stringify(operation),
              job.workspace,
              owned.operation_id!,
            );
          }
        }
      }
      this.storage.sql.exec(
        "UPDATE ingest_authorities SET revision=revision+1 WHERE workspace=?",
        job.workspace,
      );
      this.storage.sql.exec(
        "UPDATE ingest_jobs SET status=?,revision=revision+1,error=?,attempts=attempts+1,next_at=?,finished_at=?,diagnostics_json=? WHERE workspace=?",
        retry ? "pending" : "failed",
        code,
        retry
          ? Date.now() +
              Math.min(900000, 30000 * 2 ** Math.min(job.attempts, 5))
          : 0,
        retry ? null : Date.now(),
        diagnostics ? JSON.stringify(diagnostics) : null,
        job.workspace,
      );
    });
  }
}
