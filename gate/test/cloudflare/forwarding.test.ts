import { toolPayload } from "../tool-payload.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel, Response as MFResponse } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

const oldIssuer = "https://old.cloudflareaccess.com";
const newIssuer = "https://new.cloudflareaccess.com";
const origin = "https://backend.example";
const oldKeys = await generateKeyPair("RS256");
const newKeys = await generateKeyPair("RS256");
const jwks = await Promise.all(
  [oldKeys, newKeys].map(async (k) => ({
    ...(await exportJWK(k.publicKey)),
    kid: "one",
    alg: "RS256",
  })),
);
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
const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/wiki-rag-manifest.json", import.meta.url),
    "utf8",
  ),
);
const forwarder = {
  identity: "service:bridge.access",
  issuer: newIssuer,
  audience: "new-audience",
};

async function jwt(
  issuer: string,
  sub: string,
  extra: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: [issuer === oldIssuer ? "old-audience" : "new-audience"],
    sub,
    type: "app",
    iat: now,
    exp: now + 600,
    ...extra,
  })
    .setProtectedHeader({ alg: "RS256", kid: "one" })
    .sign((issuer === oldIssuer ? oldKeys : newKeys).privateKey);
}

test("forwarded human assertions retain issuer isolation and cannot grant transport privileges", async () => {
  const persist = mkdtempSync(join(tmpdir(), "gate-forward-"));
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
      ACCESS_ISSUER: oldIssuer,
      ACCESS_AUDIENCE: "old-audience",
      PUBLIC_ORIGIN: origin,
      ADMIN_IDENTITIES: '["user:admin"]',
      MCP_FORWARDER: JSON.stringify(forwarder),
      QUERY_KEY: "synthetic",
    },
    outboundService: async (req: Request) => {
      const url = new URL(req.url);
      assert.equal(url.pathname, "/cdn-cgi/access/certs");
      assert.ok([oldIssuer, newIssuer].includes(url.origin));
      return MFResponse.json({
        keys: [jwks[url.origin === oldIssuer ? 0 : 1]],
      });
    },
  };
  let mf = new Miniflare(options);
  const oldUser = await jwt(oldIssuer, "same");
  const admin = await jwt(oldIssuer, "admin");
  const bridge = await jwt(oldIssuer, "", { common_name: "bridge.access" });
  const human = await jwt(newIssuer, "same");
  async function request(
    path: string,
    body?: unknown,
    outer = admin,
    inner?: string,
  ) {
    return mf.dispatchFetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "cf-access-jwt-assertion": outer,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(inner === undefined
          ? {}
          : { "x-wiki-rag-reader-assertion": inner }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const call = (outer: string, inner?: string) =>
    request(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_workspaces", arguments: {} },
      },
      outer,
      inner,
    );
  try {
    assert.equal((await request("/identity", undefined, bridge)).status, 401);
    assert.equal(
      (await request("/identity", undefined, oldUser, human)).status,
      401,
    );
    assert.equal((await request("/identity", undefined, human)).status, 401);
    assert.equal(
      (await request("/admin/status", undefined, bridge, human)).status,
      401,
    );
    assert.equal(
      (await request("/ingest/docs/status", undefined, bridge, human)).status,
      401,
    );
    assert.deepEqual(
      await (await request("/identity", undefined, bridge, human)).json(),
      { issuer: newIssuer, key: "user:same" },
    );
    for (const invalid of [
      await jwt(newIssuer, "same", { aud: ["wrong"] }),
      await jwt(newIssuer, "same", { exp: 1 }),
      await jwt(newIssuer, "", { common_name: "reader.access" }),
      "forged",
    ]) {
      assert.equal(
        (await request("/identity", undefined, bridge, invalid)).status,
        401,
      );
    }
    assert.equal(
      (
        await request("/admin/principal", {
          id: "legacy",
          grants: { allow: [], deny: [] },
          enabled: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/admin/principal", {
          id: "reader",
          grants: { allow: ["docs"], deny: [] },
          enabled: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/admin/identity", {
          key: "user:same",
          principal: "legacy",
          enabled: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("/admin/identity", {
          key: "user:same",
          issuer: newIssuer,
          principal: "reader",
          enabled: true,
        })
      ).status,
      200,
    );
    const legacyInventory = (await (
      await request("/admin/status?kind=identities&limit=1")
    ).json()) as any;
    assert.deepEqual(
      legacyInventory.items.map((x: any) => x.principal),
      ["legacy"],
    );
    assert.equal(legacyInventory.next, null);
    const readerInventory = (await (
      await request(
        "/admin/status?kind=identities&limit=1&issuer=" +
          encodeURIComponent(newIssuer),
      )
    ).json()) as any;
    assert.deepEqual(
      readerInventory.items.map((x: any) => x.principal),
      ["reader"],
    );
    assert.equal(readerInventory.next, null);
    assert.equal(
      (
        await request("/admin/identity", {
          key: "user:same",
          issuer: "https://untrusted.cloudflareaccess.com",
          principal: "reader",
          enabled: true,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("/admin/import", {
          id: "docs",
          binding: {
            projectId: "proj_test",
            credentialEnv: "QUERY_KEY",
            stores: { guide: "vs_test", second: "vs_second" },
          },
          manifestText: JSON.stringify(fixture),
        })
      ).status,
      200,
    );
    const oldResult = (await (await call(oldUser)).json()) as any;
    assert.deepEqual(toolPayload(oldResult.result).workspaces, []);
    const newResult = (await (await call(bridge, human)).json()) as any;
    assert.deepEqual(
      toolPayload(newResult.result).workspaces.map((w: any) => w.id),
      ["docs"],
    );
    const before = await (await request("/admin/status")).json();
    await mf.dispose();
    mf = new Miniflare(options);
    assert.deepEqual(await (await request("/admin/status")).json(), before);
    assert.deepEqual(
      toolPayload(
        ((await (await call(bridge, human)).json()) as any).result,
      ).workspaces.map((w: any) => w.id),
      ["docs"],
    );
    assert.equal(
      (await request("/admin/unbind", { issuer: newIssuer, key: "user:same" }))
        .status,
      200,
    );
    const revoked = (await (await call(bridge, human)).json()) as any;
    assert.equal(revoked.result.isError, true);
    assert.deepEqual(
      toolPayload(((await (await call(oldUser)).json()) as any).result)
        .workspaces,
      [],
    );
  } finally {
    await mf.dispose();
    rmSync(persist, { recursive: true, force: true });
  }
});
