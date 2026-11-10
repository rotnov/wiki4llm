import test from "node:test";
import assert from "node:assert/strict";
import front from "../../src/cloudflare/front.js";

const env = {
  PUBLIC_ORIGIN: "https://front.example",
  BACKEND_ORIGIN: "https://backend.example",
  BRIDGE_CLIENT_ID: "synthetic-id",
  BRIDGE_CLIENT_SECRET: "synthetic-secret",
};
test("front forwards only reader surfaces with a separate signed assertion and strips credentials", async () => {
  const original = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    calls.push(req);
    assert.equal(req.url, "https://backend.example/mcp");
    assert.equal(req.headers.get("cf-access-client-id"), "synthetic-id");
    assert.equal(
      req.headers.get("cf-access-client-secret"),
      "synthetic-secret",
    );
    assert.equal(
      req.headers.get("x-wiki-rag-reader-assertion"),
      "signed-edge-assertion",
    );
    assert.equal(req.headers.get("authorization"), null);
    assert.equal(req.headers.get("cookie"), null);
    assert.equal(req.headers.get("cf-access-jwt-assertion"), null);
    assert.equal(req.redirect, "manual");
    assert.equal(await req.text(), '{"jsonrpc":"2.0"}');
    return new Response('{"ok":true}', {
      headers: {
        "content-type": "application/json",
        "set-cookie": "transport-cookie",
        "cf-access-token": "transport-token",
      },
    });
  }) as typeof fetch;
  try {
    for (const path of [
      "/admin/status",
      "/ingest/docs/status",
      "/mcp?target=elsewhere",
    ])
      assert.equal(
        (await front.fetch(new Request(env.PUBLIC_ORIGIN + path), env)).status,
        404,
      );
    assert.equal(
      (
        await front.fetch(
          new Request(env.PUBLIC_ORIGIN + "/mcp", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          }),
          env,
        )
      ).status,
      401,
    );
    assert.equal(calls.length, 0);
    for (const [header, value] of [
      ["origin", "https://other.example"],
      ["mcp-session-id", "unsupported-session"],
    ]) {
      const denied = await front.fetch(
        new Request(env.PUBLIC_ORIGIN + "/mcp", {
          method: "POST",
          body: "{}",
          headers: {
            "content-type": "application/json",
            "cf-access-jwt-assertion": "signed-edge-assertion",
            [header!]: value!,
          },
        }),
        env,
      );
      assert.equal(denied.status, 403);
      assert.equal(calls.length, 0);
    }
    const r = await front.fetch(
      new Request(env.PUBLIC_ORIGIN + "/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-access-jwt-assertion": "signed-edge-assertion",
          "x-wiki-rag-reader-assertion": "spoofed",
          authorization: "secret",
          cookie: "secret",
        },
        body: '{"jsonrpc":"2.0"}',
      }),
      env,
    );
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("set-cookie"), null);
    assert.equal(r.headers.get("cf-access-token"), null);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(calls.length, 1);
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: {
          location: "https://elsewhere.example",
          "set-cookie": "secret",
        },
      })) as typeof fetch;
    const failed = await front.fetch(
      new Request(env.PUBLIC_ORIGIN + "/identity", {
        headers: { "cf-access-jwt-assertion": "signed" },
      }),
      env,
    );
    assert.equal(failed.status, 502);
    assert.equal(failed.headers.get("location"), null);
  } finally {
    globalThis.fetch = original;
  }
});
