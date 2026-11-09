import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel, Response as MFResponse } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
const origin = "https://gate.example",
  issuer = "https://example.cloudflareaccess.com";
const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256" };
const script = (
  await build({
    entryPoints: ["src/cloudflare/worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["node:*", "cloudflare:workers"],
    target: "es2023",
  })
).outputFiles[0]!.text;
const binding = {
  projectId: "proj_test",
  credentialEnv: "QUERY_KEY",
  stores: { guide: "vs_test" },
};
const ownership = {
  project_id: "proj_test",
  collections: {
    guide: {
      repository: "example/guide",
      branch: "main",
      vector_store_id: "vs_test",
    },
  },
};
const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/wiki-rag-manifest.json", import.meta.url),
    "utf8",
  ),
);
function manifest(generation = 1) {
  const m = structuredClone(fixture);
  delete m.collections.second;
  m.collections.guide.branch = "main";
  m.collections.guide.files = {};
  m.generation = generation;
  m.publication_id = crypto.randomUUID();
  return m;
}
const op = (n = 1) => ({
  collection: "guide",
  store: "vs_test",
  path: `${n}.md`,
  version: "a".repeat(64),
  sha256: "b".repeat(64),
  source_commit: "c".repeat(40),
  filename: `wiki-rag-${n.toString(16).padStart(32, "0")}.txt`,
  phase: "upload_ready",
  ingestion_attempts: 1,
});
const oid = (n = 1) => n.toString(16).padStart(64, "0");
test("ingestion authority in real workerd", async (t) => {
  const persist = mkdtempSync(join(tmpdir(), "gate-ingest-"));
  const options = {
    modules: true,
    script,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    log: new Log(LogLevel.ERROR),
    durableObjects: {
      GATE: { className: "GateDurableObject", useSQLite: true },
    },
    durableObjectsPersist: persist,
    bindings: {
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "test",
      PUBLIC_ORIGIN: origin,
      ADMIN_IDENTITIES: '["user:admin"]',
    },
    outboundService: async () => MFResponse.json({ keys: [jwk] }),
  };
  let mf = new Miniflare(options);
  async function req(
    path: string,
    body?: unknown,
    who = "service:one.access",
    raw = false,
  ) {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      iss: issuer,
      aud: ["test"],
      type: "app",
      sub: who.startsWith("user:") ? who.slice(5) : "",
      ...(who.startsWith("service:") ? { common_name: who.slice(8) } : {}),
      iat: now,
      exp: now + 600,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .sign(keys.privateKey);
    return mf.dispatchFetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "cf-access-jwt-assertion": token,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      ...(body === undefined
        ? {}
        : { body: raw ? String(body) : JSON.stringify(body) }),
    });
  }
  async function ok(path: string, body?: unknown, who?: string) {
    const r = await req(path, body, who);
    assert.equal(r.status, 200, await r.clone().text());
    return r.json() as Promise<any>;
  }
  const admin = (path: string, body: unknown) => ok(path, body, "user:admin");
  const grant = (
    key = "service:one.access",
    enabled = true,
    deny: string[] = [],
  ) =>
    admin("/admin/publisher", { key, enabled, grants: { allow: ["*"], deny } });
  const provision = (workspace = "demo", b = binding, own = ownership) =>
    admin("/admin/ingestion", { workspace, binding: b, ownership: own });
  let proof: any,
    revision = 0;
  const base = () => ({
    ...proof,
    expected_revision: revision,
    request_id: crypto.randomUUID(),
  });
  async function delta(upserts: unknown[]) {
    const result = await ok("/ingest/demo/checkpoint", { ...base(), upserts });
    revision = result.revision;
    return result;
  }
  async function restart(sql?: string) {
    await mf.dispose();
    if (sql) {
      function walk(p: string): string[] {
        return readdirSync(p, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(join(p, e.name)) : [join(p, e.name)],
        );
      }
      const db = new DatabaseSync(
        walk(persist).find((p) => p.endsWith(".sqlite"))!,
      );
      try {
        db.exec(sql);
      } finally {
        db.close();
      }
    }
    mf = new Miniflare(options);
  }
  try {
    await t.test(
      "service-only independent grants, masks, immutable provisioning and reservation orderings",
      async () => {
        assert.equal(
          (
            await req(
              "/admin/publisher",
              {
                key: "user:reader",
                enabled: true,
                grants: { allow: ["*"], deny: [] },
              },
              "user:admin",
            )
          ).status,
          400,
        );
        await provision();
        await provision();
        assert.equal(
          (await req("/ingest/demo/status", undefined, "user:admin")).status,
          403,
        );
        assert.equal((await req("/ingest/demo/status")).status, 403);
        await grant();
        await grant("service:two.access");
        await ok("/ingest/demo/status");
        await grant("service:one.access", true, ["demo"]);
        assert.equal((await req("/ingest/demo/status")).status, 403);
        await grant();
        assert.equal(
          (
            await req("/admin/ingestion", {
              workspace: "evil",
              binding,
              ownership,
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await req(
              "/admin/ingestion",
              { workspace: "alias", binding, ownership },
              "user:admin",
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await req(
              "/admin/import",
              {
                id: "manual",
                binding,
                manifestText: JSON.stringify(manifest()),
              },
              "user:admin",
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await req(
              "/admin/import",
              { id: "demo", binding, manifestText: JSON.stringify(manifest()) },
              "user:admin",
            )
          ).status,
          409,
        );
        const b = { ...binding, stores: { guide: "vs_manual" } },
          own = structuredClone(ownership);
        own.collections.guide.vector_store_id = "vs_manual";
        const m = manifest();
        m.collections.guide.vector_store_id = "vs_manual";
        await admin("/admin/import", {
          id: "manual",
          binding: b,
          manifestText: JSON.stringify(m),
        });
        assert.equal(
          (
            await req(
              "/admin/ingestion",
              { workspace: "alias", binding: b, ownership: own },
              "user:admin",
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await req(
              "/admin/ingestion",
              { workspace: "manual", binding: b, ownership: own },
              "user:admin",
            )
          ).status,
          409,
        );
        assert.equal((await req("/ingest/alias/status")).status, 404);
      },
    );
    await t.test(
      "lease idempotence, contention, restart, revocation takeover and stale fencing",
      async () => {
        const nonce = "a".repeat(64),
          acquire = {
            action: "acquire",
            nonce,
            request_id: crypto.randomUUID(),
          };
        const lease = await ok("/ingest/demo/lease", acquire);
        proof = { epoch: lease.epoch, nonce };
        const replay = await ok("/ingest/demo/lease", acquire);
        assert.equal(replay.epoch, lease.epoch);
        assert.equal(replay.expires_at, lease.expires_at);
        assert.ok(replay.server_time >= lease.server_time);
        assert.equal(
          (
            await req(
              "/ingest/demo/lease",
              { ...acquire, nonce: "b".repeat(64) },
              "service:two.access",
            )
          ).status,
          409,
        );
        await restart();
        assert.equal(
          (await ok("/ingest/demo/lease", { action: "renew", ...proof })).epoch,
          lease.epoch,
        );
        await grant("service:one.access", false);
        assert.equal(
          (await req("/ingest/demo/lease", { action: "renew", ...proof }))
            .status,
          403,
        );
        const next = await ok(
          "/ingest/demo/lease",
          {
            action: "acquire",
            nonce: "b".repeat(64),
            request_id: crypto.randomUUID(),
          },
          "service:two.access",
        );
        assert.ok(next.epoch > lease.epoch);
        await grant();
        assert.equal(
          (await req("/ingest/demo/lease", { action: "release", ...proof }))
            .status,
          409,
        );
        await ok(
          "/ingest/demo/lease",
          { action: "release", epoch: next.epoch, nonce: "b".repeat(64) },
          "service:two.access",
        );
        const last = await ok("/ingest/demo/lease", {
          action: "acquire",
          nonce,
          request_id: crypto.randomUUID(),
        });
        proof = { epoch: last.epoch, nonce };
      },
    );
    await t.test(
      "initialize, strict delta CAS and lost response replay survive restart",
      async () => {
        const init = base();
        revision = (await ok("/ingest/demo/initialize", init)).revision;
        const command = {
          ...base(),
          upserts: [{ id: oid(), operation: op() }],
        };
        const result = await ok("/ingest/demo/checkpoint", command);
        revision = result.revision;
        await restart();
        assert.deepEqual(await ok("/ingest/demo/checkpoint", command), result);
        assert.equal(
          (await req("/ingest/demo/checkpoint", { ...command, upserts: [] }))
            .status,
          409,
        );
        assert.equal(
          (
            await req("/ingest/demo/checkpoint", {
              ...command,
              request_id: crypto.randomUUID(),
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await req("/ingest/demo/checkpoint", {
              ...base(),
              upserts: [{ id: oid(2), operation: { ...op(2), secret: "bad" } }],
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await req("/ingest/demo/checkpoint", {
              ...base(),
              upserts: [
                { id: oid(2), operation: { ...op(2), store: "vs_other" } },
              ],
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await req("/ingest/demo/checkpoint", {
              ...base(),
              upserts: [
                {
                  id: oid(),
                  operation: { ...op(), phase: "complete", file_id: "file-1" },
                },
              ],
            })
          ).status,
          409,
        );
        const state = await ok("/ingest/demo/snapshot", { ...proof, revision });
        assert.equal(state.revision, revision);
        assert.equal(state.initialized, true);
      },
    );
    let currentOp: any;
    await t.test(
      "certified publication, active retirement rejection, lease-free pinned chunks and existing MCP read",
      async () => {
        currentOp = op();
        for (const phase of [
          "upload_pending",
          "uploaded",
          "attach_pending",
          "attached",
          "complete",
        ]) {
          currentOp = {
            ...currentOp,
            phase,
            ...(phase === "uploaded" ? { file_id: "file-1" } : {}),
          };
          await delta([{ id: oid(), operation: currentOp }]);
        }
        const m = manifest();
        m.collections.guide.files["1.md"] = {
          ...fixture.collections.guide.files["README.md"],
          path: "1.md",
          operation_id: oid(),
          file_id: "file-1",
          sha256: currentOp.sha256,
          version: currentOp.version,
          source_commit: currentOp.source_commit,
        };
        const command = { ...base(), manifestText: JSON.stringify(m) };
        const publication = await ok("/ingest/demo/publish", command);
        revision = publication.revision;
        assert.deepEqual(
          await ok("/ingest/demo/publish", command),
          publication,
        );
        assert.equal(
          (
            await req("/ingest/demo/checkpoint", {
              ...base(),
              upserts: [
                {
                  id: oid(),
                  operation: { ...currentOp, phase: "detach_pending" },
                },
              ],
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await req("/ingest/demo/checkpoint", {
              ...base(),
              upserts: [
                {
                  id: oid(8),
                  operation: { ...op(8), phase: "uploaded", file_id: "file-1" },
                },
              ],
            })
          ).status,
          409,
        );
        const meta = await ok(
          "/ingest/demo/publication",
          undefined,
          "service:two.access",
        );
        assert.equal(meta.generation, publication.generation);
        const part = await req(
          `/ingest/demo/publication?generation=${meta.generation}&part=0`,
          undefined,
          "service:two.access",
        );
        assert.equal(part.status, 200);
        assert.equal(
          JSON.parse(await part.text()).manifest.publication_id,
          m.publication_id,
        );
        const noop = await ok("/ingest/demo/publish", {
          ...base(),
          manifestText: JSON.stringify(m),
        });
        revision = noop.revision;
        assert.equal(noop.generation, meta.generation);
        await admin("/admin/principal", {
          id: "reader",
          enabled: true,
          grants: { allow: ["demo"], deny: [] },
        });
        await admin("/admin/identity", {
          key: "user:reader",
          principal: "reader",
          enabled: true,
        });
        await delta([{ id: oid(2), operation: op(2) }]);
        const r = await req(
          "/mcp",
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "status", arguments: { workspaces: ["demo"] } },
          },
          "user:reader",
        );
        assert.equal(r.status, 200);
        assert.equal(((await r.json()) as any).result.isError, undefined);
        const newer = manifest(2);
        const result = await ok("/ingest/demo/publish", {
          ...base(),
          manifestText: JSON.stringify(newer),
        });
        revision = result.revision;
        assert.equal(
          (
            await req(
              `/ingest/demo/publication?generation=${meta.generation}&part=0`,
            )
          ).status,
          409,
        );
      },
    );
    await t.test(
      "bounded lookup, keyset cleanup pages, no skipped rows and revision consistency",
      async () => {
        for (let i = 3; i <= 105; i += 100)
          await delta(
            Array.from({ length: Math.min(100, 106 - i) }, (_, j) => ({
              id: oid(i + j),
              operation: op(i + j),
            })),
          );
        const first = await ok("/ingest/demo/operations", {
          ...proof,
          revision,
          limit: 100,
          after: "",
          cleanup: true,
        });
        assert.equal(first.items.length, 100);
        assert.ok(first.next);
        const next = await ok("/ingest/demo/operations", {
          ...proof,
          revision,
          limit: 100,
          after: first.next,
          cleanup: true,
        });
        assert.equal(next.items.length, 5);
        assert.equal(next.next, null);
        const lookup = await ok("/ingest/demo/operations", {
          ...proof,
          revision,
          ids: [oid(), oid(999)],
        });
        assert.equal(lookup.items.length, 1);
        assert.equal(
          (
            await req("/ingest/demo/operations", {
              ...proof,
              revision: revision - 1,
              after: "",
            })
          ).status,
          409,
        );
      },
    );
    await t.test(
      "retirement receipts are preserved atomically and retired IDs cannot reactivate",
      async () => {
        for (const phase of [
          "detach_pending",
          "detached",
          "file_delete_pending",
          "deleted",
        ]) {
          currentOp = { ...currentOp, phase };
          await delta([{ id: oid(), operation: currentOp }]);
        }
        const retired_id = oid() + ".retired." + "e".repeat(32);
        const replacement = {
          ...op(),
          filename: "wiki-rag-" + "e".repeat(32) + ".txt",
        };
        const result = await ok("/ingest/demo/checkpoint", {
          ...base(),
          retire: [{ id: oid(), retired_id }],
          upserts: [{ id: oid(), operation: replacement }],
        });
        revision = result.revision;
        const records = await ok("/ingest/demo/operations", {
          ...proof,
          revision,
          ids: [oid(), retired_id],
        });
        assert.equal(records.items.length, 2);
        assert.equal(records.items[1].operation.phase, "deleted");
        assert.equal(records.items[0].operation.phase, "upload_ready");
        await delta([
          { id: oid(), operation: { ...replacement, phase: "upload_pending" } },
        ]);
        assert.equal(
          (
            await req("/ingest/demo/checkpoint", {
              ...base(),
              upserts: [
                {
                  id: oid(),
                  operation: {
                    ...replacement,
                    phase: "uploaded",
                    file_id: "file-1",
                  },
                },
              ],
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await req("/ingest/demo/checkpoint", {
              ...base(),
              upserts: [
                {
                  id: retired_id,
                  operation: { ...currentOp, phase: "complete" },
                },
              ],
            })
          ).status,
          409,
        );
      },
    );
    await t.test(
      "authority disable revokes its lease and immutable configuration survives re-enable",
      async () => {
        await admin("/admin/ingestion", {
          workspace: "demo",
          binding,
          ownership,
          enabled: false,
        });
        assert.equal((await req("/ingest/demo/status")).status, 403);
        await provision();
        assert.equal(
          (await req("/ingest/demo/lease", { action: "renew", ...proof }))
            .status,
          409,
        );
        const lease = await ok("/ingest/demo/lease", {
          action: "acquire",
          nonce: "f".repeat(64),
          request_id: crypto.randomUUID(),
        });
        proof = { epoch: lease.epoch, nonce: "f".repeat(64) };
        const wrong = structuredClone(ownership);
        wrong.collections.guide.branch = "other";
        assert.equal(
          (
            await req(
              "/admin/ingestion",
              { workspace: "demo", binding, ownership: wrong },
              "user:admin",
            )
          ).status,
          409,
        );
      },
    );
    await t.test(
      "long operation pages stop before the byte cap and ID lookup cannot silently truncate",
      async () => {
        const long = (n: number) => ({
          id: oid(n),
          operation: { ...op(n), path: "文".repeat(1000) + ".md" },
        });
        for (let n = 200; n < 400; n += 100)
          await delta(Array.from({ length: 100 }, (_, j) => long(n + j)));
        assert.equal(
          (
            await req("/ingest/demo/operations", {
              ...proof,
              revision,
              ids: Array.from({ length: 100 }, (_, j) => oid(200 + j)),
            })
          ).status,
          400,
        );
        let after = oid(199),
          total = 0;
        do {
          const r = await req("/ingest/demo/operations", {
            ...proof,
            revision,
            after,
            limit: 100,
          });
          const text = await r.text();
          assert.equal(r.status, 200);
          assert.ok(Buffer.byteLength(text) <= 512 * 1024);
          const page = JSON.parse(text);
          total += page.items.length;
          if (page.next) assert.ok(page.next > after);
          after = page.next;
        } while (after);
        assert.equal(total, 200);
      },
    );
    await t.test(
      "upload names and retries preserve unique attempt ownership",
      async () => {
        assert.equal(
          (
            await req("/ingest/demo/checkpoint", {
              ...base(),
              upserts: [
                {
                  id: oid(900),
                  operation: { ...op(900), filename: op(2).filename },
                },
              ],
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await req("/ingest/demo/checkpoint", {
              ...base(),
              upserts: [
                {
                  id: oid(900),
                  operation: { ...op(900), ingestion_attempts: 3 },
                },
              ],
            })
          ).status,
          409,
        );
      },
    );
    await t.test(
      "evicted command receipts cannot replay against a newer revision",
      async () => {
        const old = { ...base(), upserts: [] };
        revision = (await ok("/ingest/demo/checkpoint", old)).revision;
        for (let n = 0; n < 256; n++) await delta([]);
        assert.equal((await req("/ingest/demo/checkpoint", old)).status, 409);
      },
    );
    await t.test(
      "duplicate command fields and unsafe revisions reject without mutation",
      async () => {
        const command = { ...base(), upserts: [] };
        const raw = JSON.stringify(command).replace(
          '"upserts":[]',
          '"upserts":[],"upserts":[]',
        );
        assert.equal(
          (
            await req(
              "/ingest/demo/checkpoint",
              raw,
              "service:one.access",
              true,
            )
          ).status,
          400,
        );
        assert.equal(
          (
            await req("/ingest/demo/checkpoint", {
              ...command,
              expected_revision: Number.MAX_SAFE_INTEGER + 1,
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await req("/ingest/demo/checkpoint", {
              ...command,
              nonce: "0".repeat(64),
            })
          ).status,
          409,
        );
        assert.equal((await ok("/ingest/demo/status")).revision, revision);
      },
    );
    await t.test(
      "simultaneous independent publishers have one lease winner",
      async () => {
        const b = { ...binding, stores: { guide: "vs_race" } },
          own = structuredClone(ownership);
        own.collections.guide.vector_store_id = "vs_race";
        await provision("race", b, own);
        const results = await Promise.all(
          ["service:one.access", "service:two.access"].map((who) =>
            req(
              "/ingest/race/lease",
              {
                action: "acquire",
                nonce: crypto.randomUUID().replaceAll("-", "").repeat(2),
                request_id: crypto.randomUUID(),
              },
              who,
            ),
          ),
        );
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      },
    );
    await t.test(
      "atomic rollback after gate chunk writes, persisted lease expiry, quota refusal",
      async () => {
        const before = await ok("/ingest/demo/publication");
        await restart(
          "CREATE TRIGGER fail_ingest_receipt BEFORE INSERT ON ingest_receipts BEGIN SELECT RAISE(ABORT,'injected'); END;",
        );
        assert.equal(
          (
            await req("/ingest/demo/publish", {
              ...base(),
              manifestText: JSON.stringify(manifest(3)),
            })
          ).status,
          400,
        );
        await restart("DROP TRIGGER fail_ingest_receipt;");
        assert.deepEqual(await ok("/ingest/demo/publication"), before);
        assert.equal(
          (await ok("/ingest/demo/snapshot", { ...proof, revision })).revision,
          revision,
        );
        await restart(
          "UPDATE ingest_authorities SET lease_expires=0 WHERE workspace='demo';",
        );
        assert.equal(
          (await req("/ingest/demo/lease", { action: "renew", ...proof }))
            .status,
          409,
        );
        const lease = await ok("/ingest/demo/lease", {
          action: "acquire",
          nonce: "d".repeat(64),
          request_id: crypto.randomUUID(),
        });
        assert.ok(lease.epoch > proof.epoch);
        proof = { epoch: lease.epoch, nonce: "d".repeat(64) };
        await restart(
          "UPDATE ingest_authorities SET operation_count=100000 WHERE workspace='demo';",
        );
        assert.equal(
          (
            await req("/ingest/demo/checkpoint", {
              ...base(),
              upserts: [{ id: oid(999), operation: op(999) }],
            })
          ).status,
          409,
        );
      },
    );
  } finally {
    await mf.dispose();
    rmSync(persist, { recursive: true, force: true });
  }
});
