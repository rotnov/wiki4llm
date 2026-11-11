import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel, Response as MFResponse } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const issuer = "https://example.cloudflareaccess.com";
const origin = "https://gate.example";
const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256" };
const script = (
  await build({
    stdin: {
      contents: `import worker, {GateDurableObject as Base} from './src/cloudflare/worker.ts';
      export default worker;
      export class GateDurableObject extends Base {
        constructor(ctx,env){super(ctx,env);this.testStorage=ctx.storage;}
        async fetch(req){
          if(new URL(req.url).pathname==='/test-only/alarm') {
            this.testStorage.sql.exec("UPDATE ingest_jobs SET next_at=0 WHERE status='pending'");
            await this.alarm(); return Response.json({ok:true});
          }
          return super.fetch(req);
        }
      }`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["node:*", "cloudflare:workers"],
    target: "es2023",
  })
).outputFiles[0]!.text;
const template = JSON.parse(
  readFileSync(
    new URL("../fixtures/wiki-rag-manifest.json", import.meta.url),
    "utf8",
  ),
);

async function setup(branch: string | null = "main") {
  let state = "in_progress";
  let requests = 0;
  let intercept: (() => Promise<void>) | undefined;
  let responseText: string | undefined;
  const files: Record<string, unknown>[] = [];
  const mf = new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    log: new Log(LogLevel.ERROR),
    durableObjects: {
      GATE: { className: "GateDurableObject", useSQLite: true },
    },
    bindings: {
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "test",
      PUBLIC_ORIGIN: origin,
      ADMIN_IDENTITIES: '["user:admin"]',
      QUERY_KEY: "synthetic",
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== "api.openai.com")
        return MFResponse.json({ keys: [jwk] });
      requests++;
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), "Bearer synthetic");
      assert.equal(request.headers.get("openai-project"), "proj_test");
      if (intercept) await intercept();
      if (responseText !== undefined)
        return new MFResponse(responseText, { status: 200 });
      return MFResponse.json({
        data: files.map((f) => ({ ...f, status: state })),
        has_more: false,
        last_id: files.at(-1)?.id,
      });
    },
  });
  async function req(path: string, body?: unknown, who = "service:one.access") {
    const token = await new SignJWT({
      iss: issuer,
      aud: ["test"],
      type: "app",
      sub: who.startsWith("user:") ? who.slice(5) : "",
      ...(who.startsWith("service:") ? { common_name: who.slice(8) } : {}),
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 600,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .sign(keys.privateKey);
    return mf.dispatchFetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "cf-access-jwt-assertion": token,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function ok(path: string, body?: unknown, who?: string): Promise<any> {
    const r = await req(path, body, who);
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  }
  const grants = (enabled = true) =>
    ok(
      "/admin/publisher",
      {
        key: "service:one.access",
        enabled,
        grants: { allow: ["demo"], deny: [] },
      },
      "user:admin",
    );
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
        branch,
        vector_store_id: "vs_test",
      },
    },
  };
  const provision = (enabled = true) =>
    ok(
      "/admin/ingestion",
      { workspace: "demo", binding, ownership, enabled },
      "user:admin",
    );
  await provision();
  await grants();
  let proof: any = await ok("/ingest/demo/lease", {
    action: "acquire",
    nonce: "a".repeat(64),
    request_id: crypto.randomUUID(),
  });
  proof = { epoch: proof.epoch, nonce: "a".repeat(64) };
  let revision = 0;
  const command = async (
    action: string,
    extra: Record<string, unknown> = {},
  ) => {
    const result = await ok("/ingest/demo/" + action, {
      ...proof,
      expected_revision: revision,
      request_id: crypto.randomUUID(),
      ...extra,
    });
    revision = result.revision;
    return result;
  };
  await command("initialize");
  const operation = {
    collection: "guide",
    store: "vs_test",
    path: "one.md",
    version: "a".repeat(64),
    sha256: "b".repeat(64),
    source_commit: "c".repeat(40),
    filename: `wiki-rag-${"1".repeat(32)}.txt`,
    phase: "upload_ready",
    ingestion_attempts: 1,
  };
  const oid = "1".repeat(64);
  for (const phase of [
    "upload_ready",
    "upload_pending",
    "uploaded",
    "attach_pending",
    "attached",
  ]) {
    await command("checkpoint", {
      upserts: [
        {
          id: oid,
          operation: {
            ...operation,
            phase,
            ...(["upload_ready", "upload_pending"].includes(phase)
              ? {}
              : { file_id: "file-one" }),
          },
        },
      ],
    });
  }
  const manifest = structuredClone(template);
  delete manifest.collections.second;
  manifest.generation = 1;
  manifest.publication_id = crypto.randomUUID();
  manifest.collections.guide.branch = branch;
  manifest.collections.guide.repository_commit = "c".repeat(40);
  manifest.collections.guide.files = {
    "one.md": {
      file_id: "file-one",
      vector_store_id: "vs_test",
      path: "one.md",
      sha256: operation.sha256,
      version: operation.version,
      kind: "md",
      source_commit: operation.source_commit,
      preprocessing: "utf8-text-v1",
      operation_id: oid,
    },
  };
  files.push({
    id: "file-one",
    vector_store_id: "vs_test",
    attributes: {
      repository: "example/guide",
      path: "one.md",
      commit: operation.source_commit,
      kind: "md",
      collection: "guide",
      branch: branch ?? "unspecified",
      sha256: operation.sha256,
      operation_id: oid,
    },
  });
  const ns = await mf.getDurableObjectNamespace("GATE");
  const stub = ns.get(ns.idFromName("authority-v1"));
  const tick = async () => {
    const r = await stub.fetch(origin + "/test-only/alarm");
    assert.equal(r.status, 200, await r.text());
  };
  return {
    mf,
    req,
    ok,
    grants,
    provision,
    command,
    manifest,
    files,
    status: () => ok("/ingest/demo/status"),
    submit: () => command("submit", { manifestText: JSON.stringify(manifest) }),
    release: () => ok("/ingest/demo/lease", { ...proof, action: "release" }),
    acquire: () =>
      ok("/ingest/demo/lease", {
        action: "acquire",
        nonce: "d".repeat(64),
        request_id: crypto.randomUUID(),
      }),
    tick,
    setState: (value: string) => {
      state = value;
    },
    setIntercept: (value: (() => Promise<void>) | undefined) => {
      intercept = value;
    },
    setResponse: (value: string) => {
      responseText = value;
    },
    requests: () => requests,
  };
}

test("background finalization accepts a valid branchless collection", async () => {
  const f = await setup(null);
  try {
    await f.submit();
    await f.release();
    f.setState("completed");
    await f.tick();
    assert.equal((await f.status()).job.status, "complete");
  } finally {
    await f.mf.dispose();
  }
});

test(
  "truncated provider JSON fails without looping",
  { timeout: 3000 },
  async () => {
    const f = await setup();
    try {
      await f.submit();
      await f.release();
      f.setResponse('{"data":[');
      await f.tick();
      const status = await f.status();
      assert.equal(status.job.status, "failed");
      assert.equal(status.job.error, "provider_response");
      assert.equal(status.publication, null);
    } finally {
      await f.mf.dispose();
    }
  },
);

test(
  "scheduled alarm completes without a publisher or manual tick",
  { timeout: 10000 },
  async () => {
    const f = await setup();
    try {
      f.setState("completed");
      await f.submit();
      await f.release();
      let state = await f.status();
      const until = Date.now() + 8000;
      while (state.job.status === "pending" && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 50));
        state = await f.status();
      }
      assert.equal(state.job.status, "complete");
      assert.ok(f.requests() > 0);
    } finally {
      await f.mf.dispose();
    }
  },
);

test("submission returns before readiness and alarm publishes the exact snapshot", async () => {
  const f = await setup();
  try {
    const submitted = await f.submit();
    assert.ok(submitted.job_id);
    assert.equal(f.requests(), 0);
    assert.equal((await f.status()).publication, null);
    assert.equal((await f.status()).job.status, "pending");
    await f.release();
    await f.tick();
    assert.equal((await f.status()).publication, null);
    f.setState("completed");
    await f.tick();
    const done = await f.status();
    assert.equal(done.job.status, "complete");
    assert.equal(done.job.publication_id, f.manifest.publication_id);
    assert.ok(done.publication);
    const count = f.requests();
    await f.tick();
    assert.equal(f.requests(), count);
  } finally {
    await f.mf.dispose();
  }
});

test("foreign manifest file is rejected before a background job is accepted", async () => {
  const f = await setup();
  try {
    f.manifest.collections.guide.files["one.md"].file_id = "file-foreign";
    await assert.rejects(f.submit);
    assert.equal(f.requests(), 0);
    assert.equal((await f.status()).job, null);
  } finally {
    await f.mf.dispose();
  }
});

for (const change of ["revoke", "disable", "new-writer"]) {
  test(`background result cannot publish across ${change}`, async () => {
    const f = await setup();
    try {
      await f.submit();
      await f.release();
      f.setState("completed");
      let entered!: () => void, finish!: () => void;
      const started = new Promise<void>((r) => {
        entered = r;
      });
      const pause = new Promise<void>((r) => {
        finish = r;
      });
      f.setIntercept(async () => {
        entered();
        await pause;
      });
      const tick = f.tick();
      await started;
      if (change === "revoke") {
        await f.grants(false);
        await f.grants(true);
      }
      if (change === "disable") {
        await f.provision(false);
        await f.provision(true);
      }
      if (change === "new-writer") await f.acquire();
      finish();
      await tick;
      const status = await f.status();
      assert.equal(status.publication, null);
      assert.equal(
        status.job.status,
        change === "new-writer" ? "superseded" : "revoked",
      );
    } finally {
      await f.mf.dispose();
    }
  });
}

test("terminal indexing failure and metadata mismatch never publish", async () => {
  for (const failure of ["failed", "metadata"]) {
    const f = await setup();
    try {
      await f.submit();
      await f.release();
      f.setState(failure === "failed" ? "failed" : "completed");
      if (failure === "metadata")
        f.files[0]!.attributes = { operation_id: "f".repeat(64) };
      await f.tick();
      const status = await f.status();
      assert.equal(status.publication, null);
      assert.equal(status.job.status, "failed");
    } finally {
      await f.mf.dispose();
    }
  }
});

test("metadata failure names the field and state without leaking its value", async () => {
  const f = await setup();
  try {
    await f.submit();
    await f.release();
    f.setState("completed");
    (f.files[0]!.attributes as Record<string, unknown>).commit =
      "private-value-must-not-be-logged";
    await f.tick();
    const status = await f.status();
    assert.equal(status.job.status, "failed");
    assert.equal(status.publication, null);
    assert.equal(status.job.error, "provider_metadata_commit_completed");
    assert.ok(!JSON.stringify(status.job).includes("private-value"));
  } finally {
    await f.mf.dispose();
  }
});
