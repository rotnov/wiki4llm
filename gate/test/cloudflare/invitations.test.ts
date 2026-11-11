import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, Response as MFResponse, Log, LogLevel } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { readFileSync } from "node:fs";
const issuer = "https://example.cloudflareaccess.com",
  origin = "https://gate.example";
const keys = await generateKeyPair("RS256");
const jwk = {
  ...(await exportJWK(keys.publicKey)),
  kid: "invite",
  alg: "RS256",
};
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
async function token(sub: string, email?: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: ["aud"],
    type: "app",
    sub,
    iat: now,
    exp: now + 600,
    ...(email ? { email } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: "invite" })
    .sign(keys.privateKey);
}
test("invitation activation binds only its authenticated recipient and preserves access boundaries", async () => {
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
      ACCESS_AUDIENCE: "aud",
      PUBLIC_ORIGIN: origin,
      ADMIN_IDENTITIES: '["user:operator"]',
      QUERY_KEY: "sk-fixture00",
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.origin === issuer) return MFResponse.json({ keys: [jwk] });
      assert.equal(url.origin, "https://api.openai.com");
      if (url.pathname.endsWith("/search"))
        return MFResponse.json({
          data: [
            {
              file_id: url.pathname.includes("vs_second") ? "file-3" : "file-1",
              content: [{ type: "text", text: "fixture" }],
            },
          ],
          has_more: false,
        });
      return MFResponse.json({
        data: [{ type: "text", text: "invited reader document" }],
        has_more: false,
      });
    },
  });
  async function req(
    path: string,
    body?: unknown,
    sub = "operator",
    email?: string,
    extra: Record<string, string> = {},
  ) {
    return mf.dispatchFetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "cf-access-jwt-assertion": await token(sub, email),
        "content-type": "application/json",
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function rpc(name: string, args: unknown = {}) {
    const response = await req(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
      "recipient",
      undefined,
      { accept: "application/json, text/event-stream" },
    );
    assert.equal(response.status, 200);
    return ((await response.json()) as any).result;
  }
  async function create(email = "person@example.org") {
    const r = await req("/admin/invitation", {
      email,
      workspaces: ["example"],
    });
    assert.equal(r.status, 200, await r.clone().text());
    return (await r.json()) as { id: string; url: string; expiresAt: number };
  }
  try {
    const manifest = readFileSync(
      new URL("../fixtures/wiki-rag-manifest.json", import.meta.url),
      "utf8",
    );
    assert.equal(
      (
        await req("/admin/import", {
          id: "example",
          binding: {
            projectId: "proj_test",
            credentialEnv: "QUERY_KEY",
            stores: { guide: "vs_test", second: "vs_second" },
          },
          manifestText: manifest,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await req(
          "/admin/invitation",
          { email: "person@example.org", workspaces: ["example"] },
          "reader",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await req("/admin/invitation", {
          email: "person@example.org",
          workspaces: ["*"],
        })
      ).status,
      400,
    );
    assert.equal((await rpc("list_workspaces")).isError, true);
    const invitation = await create();
    const path = new URL(invitation.url).pathname;
    assert.equal((await mf.dispatchFetch(invitation.url)).status, 401);
    const page = await req(path, undefined, "recipient", "person@example.org");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type")!, /text\/html/);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    let inventory = (await (
      await req("/admin/status?kind=identities")
    ).json()) as any;
    assert.equal(inventory.items.length, 0, "GET must not bind permissions");
    assert.equal(
      (await req(path, {}, "recipient", "other@example.org", { origin }))
        .status,
      403,
    );
    assert.equal(
      (
        await req(path, {}, "recipient", undefined, {
          origin,
          "cf-access-authenticated-user-email": "person@example.org",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await req(path, {}, "recipient", "person@example.org", {
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (await req(path, {}, "recipient", "person@example.org")).status,
      403,
    );
    const activated = await req(path, {}, "recipient", "person@example.org", {
      origin,
    });
    assert.equal(activated.status, 200, await activated.clone().text());
    const result = (await activated.json()) as any;
    assert.deepEqual(result.workspaces, ["example"]);
    assert.deepEqual(
      (await rpc("list_workspaces")).structuredContent.workspaces,
      [{ id: "example", indexed: true }],
    );
    const query = (await rpc("query", { query: "fixture" })).structuredContent;
    assert.equal(
      (await rpc("get", { ref: query.results[0].ref })).structuredContent.text,
      "invited reader document",
    );
    assert.equal(
      (await rpc("query", { query: "fixture", workspaces: ["other"] })).isError,
      true,
    );
    assert.equal(
      result.prompt,
      "Connect wiki4llm MCP as a web connection: https://gate.example/mcp.\nUse person@example.org to sign in; I will complete the browser authentication myself.\nAfter connecting, verify access to example and retrieve a document.",
    );
    inventory = (await (
      await req("/admin/status?kind=identities")
    ).json()) as any;
    assert.equal(inventory.items[0].id, "user:recipient");
    assert.equal(
      (await req(path, {}, "recipient", "person@example.org", { origin }))
        .status,
      409,
    );
    const revoked = await create();
    assert.equal(
      (await req("/admin/invitation-revoke", { id: revoked.id })).status,
      200,
    );
    assert.equal(
      (
        await req(
          new URL(revoked.url).pathname,
          {},
          "recipient",
          "person@example.org",
          { origin },
        )
      ).status,
      403,
    );
    const raced = await create("race@example.org");
    const races = await Promise.all([
      req(new URL(raced.url).pathname, {}, "race", "race@example.org", {
        origin,
      }),
      req(new URL(raced.url).pathname, {}, "race", "race@example.org", {
        origin,
      }),
    ]);
    assert.deepEqual(races.map((r) => r.status).sort(), [200, 409]);
    // Existing shared principals and deny rules must survive without expanding peers.
    await req("/admin/principal", {
      id: "shared",
      enabled: true,
      grants: { allow: ["old"], deny: ["example"] },
    });
    for (const key of ["user:existing", "user:peer"])
      await req("/admin/identity", { key, principal: "shared", enabled: true });
    const existing = await create("existing@example.org");
    const existingResult = await req(
      new URL(existing.url).pathname,
      {},
      "existing",
      "existing@example.org",
      { origin },
    );
    assert.equal(existingResult.status, 200);
    assert.deepEqual(((await existingResult.json()) as any).workspaces, []);
    const principals = (await (
      await req("/admin/status?kind=principals")
    ).json()) as any;
    assert.equal(
      principals.items.find((p: any) => p.id === "shared").grants_json,
      '{"allow":["old"],"deny":["example"]}',
    );
    await req("/admin/identity", {
      key: "user:disabled",
      principal: "shared",
      enabled: false,
    });
    const disabled = await create("disabled@example.org");
    assert.equal(
      (
        await req(
          new URL(disabled.url).pathname,
          {},
          "disabled",
          "disabled@example.org",
          { origin },
        )
      ).status,
      403,
    );
  } finally {
    await mf.dispose();
  }
});

test("reader realm invitations bind the reader subject, never the bridge or primary realm", async () => {
  const readerIssuer = "https://reader.cloudflareaccess.com",
    readerOrigin = "https://reader.example";
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
      ACCESS_AUDIENCE: "aud",
      PUBLIC_ORIGIN: origin,
      ADMIN_IDENTITIES: '["user:operator"]',
      READER_ORIGIN: readerOrigin,
      MCP_FORWARDER: JSON.stringify({
        identity: "service:bridge.access",
        issuer: readerIssuer,
        audience: "reader-aud",
      }),
    },
    outboundService: async () => MFResponse.json({ keys: [jwk] }),
  });
  async function admin(path: string, body: unknown) {
    return mf.dispatchFetch(origin + path, {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": await token("operator"),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }
  try {
    const manifest = readFileSync(
      new URL("../fixtures/wiki-rag-manifest.json", import.meta.url),
      "utf8",
    );
    assert.equal(
      (
        await admin("/admin/import", {
          id: "example",
          binding: {
            projectId: "proj_test",
            credentialEnv: "QUERY_KEY",
            stores: { guide: "vs_test", second: "vs_second" },
          },
          manifestText: manifest,
        })
      ).status,
      200,
    );
    const created = await admin("/admin/invitation", {
      email: "person@example.org",
      workspaces: ["example"],
    });
    const invite = (await created.json()) as any;
    assert.equal(new URL(invite.url).origin, readerOrigin);
    const now = Math.floor(Date.now() / 1000);
    const sign = (claims: Record<string, unknown>) =>
      new SignJWT({ type: "app", iat: now, exp: now + 600, ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "invite" })
        .sign(keys.privateKey);
    const bridge = await sign({
      iss: issuer,
      aud: ["aud"],
      sub: "",
      common_name: "bridge.access",
    });
    const reader = await sign({
      iss: readerIssuer,
      aud: ["reader-aud"],
      sub: "recipient",
      email: "person@example.org",
    });
    const path = new URL(invite.url).pathname;
    const headers = {
      "cf-access-jwt-assertion": bridge,
      "x-wiki-rag-reader-assertion": reader,
      "content-type": "application/json",
      origin: readerOrigin,
    };
    const wrong = await mf.dispatchFetch(origin + path, {
      method: "POST",
      headers: {
        ...headers,
        "cf-access-jwt-assertion": await token(
          "recipient",
          "person@example.org",
        ),
        "x-wiki-rag-reader-assertion": "forged",
      },
      body: "{}",
    });
    assert.equal(wrong.status, 401);
    const result = await mf.dispatchFetch(origin + path, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(result.status, 200, await result.clone().text());
    assert.match(
      ((await result.json()) as any).prompt,
      /https:\/\/reader.example\/mcp/,
    );
    const identities = await mf.dispatchFetch(
      origin +
        "/admin/status?kind=identities&issuer=" +
        encodeURIComponent(readerIssuer),
      { headers: { "cf-access-jwt-assertion": await token("operator") } },
    );
    assert.equal(
      ((await identities.json()) as any).items[0].id,
      "user:recipient",
    );
    const escalated = await mf.dispatchFetch(origin + "/admin/invitation", {
      method: "POST",
      headers: { ...headers, origin: "" },
      body: "{}",
    });
    assert.equal(escalated.status, 401);
  } finally {
    await mf.dispose();
  }
});
