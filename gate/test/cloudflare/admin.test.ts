import test from "node:test";
import assert from "node:assert/strict";
import {
  adminRequest,
  parseAdminArguments,
} from "../../scripts/cloudflare-admin.js";
test("operator client sends env-only Access credentials to exact configured HTTPS origin", async () => {
  assert.ok(adminRequest, "operator client exists");
  let observed: unknown;
  const result = await adminRequest(
    "https://gate.example",
    "principal",
    { id: "example" },
    {
      GATE_ACCESS_CLIENT_ID: "test-id",
      GATE_ACCESS_CLIENT_SECRET: "test-secret",
    },
    async (url, init) => {
      observed = { url, init };
      return Response.json({ ok: true });
    },
  );
  assert.deepEqual(result, { ok: true });
  const { url, init } = observed as { url: string; init: RequestInit };
  assert.equal(url, "https://gate.example/admin/principal");
  assert.equal(init.redirect, "error");
  assert.equal(
    new Headers(init.headers).get("cf-access-client-secret"),
    "test-secret",
  );
  for (const url of [
    "http://gate.example",
    "https://user:pass@gate.example",
    "https://gate.example/path",
    "https://gate.example?x=1",
  ])
    await assert.rejects(
      adminRequest(url, "status", undefined, {}, async () => {
        throw Error("must not fetch");
      }),
    );
});
test("operator errors never echo credentials or provider bodies and cannot redirect", async () => {
  assert.ok(adminRequest, "operator client exists");
  for (const response of [
    new Response("secret detail", { status: 403 }),
    new Response("secret detail", {
      status: 302,
      headers: { location: "https://other.example" },
    }),
    new Response("x".repeat(65537)),
  ]) {
    await assert.rejects(
      adminRequest(
        "https://gate.example",
        "status",
        undefined,
        { GATE_ACCESS_ASSERTION: "test-assertion" },
        async () => response,
      ),
      (e: Error) =>
        !e.message.includes("secret") && !e.message.includes("assertion"),
    );
  }
  await assert.rejects(
    adminRequest("https://gate.example", "status", undefined, {}),
  );
});
test("operator client rejects unexpected successful response fields", async () => {
  assert.ok(adminRequest);
  await assert.rejects(
    adminRequest(
      "https://gate.example",
      "principal",
      {},
      { GATE_ACCESS_ASSERTION: "sensitive-value" },
      async () => Response.json({ ok: true, assertion: "sensitive-value" }),
    ),
  );
});
test("operator status selects bounded inventory and follows encoded cursors", async () => {
  const urls: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    urls.push(String(input));
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    return Response.json({ items: [], next: null });
  };
  for (const kind of ["workspaces", "principals", "identities"]) {
    await adminRequest(
      "https://gate.example",
      "status",
      { kind, limit: 7, after: "service:client.access" },
      {
        GATE_ACCESS_CLIENT_ID: "test-id",
        GATE_ACCESS_CLIENT_SECRET: "test-secret",
      },
      transport,
    );
    const url = new URL(urls.at(-1)!);
    assert.equal(url.pathname, "/admin/status");
    assert.equal(url.searchParams.get("kind"), kind);
    assert.equal(url.searchParams.get("limit"), "7");
    assert.equal(url.searchParams.get("after"), "service:client.access");
  }
  for (const options of [
    null,
    [],
    { kind: "tokens" },
    { limit: 0 },
    { limit: 21 },
    { limit: 1.5 },
    { limit: "3" },
    { after: "x".repeat(301) },
    { after: "\n" },
    { extra: true },
  ])
    await assert.rejects(
      adminRequest(
        "https://gate.example",
        "status",
        options,
        { GATE_ACCESS_ASSERTION: "test" },
        async () => Response.json({ items: [], next: null }),
      ),
    );
});
test("operator CLI validates explicit status flags and rejects accidental writes", async () => {
  const parse = parseAdminArguments;
  assert.deepEqual(
    parse([
      "https://gate.example",
      "status",
      "--kind",
      "identities",
      "--issuer",
      "https://reader.cloudflareaccess.com",
    ]).status,
    { kind: "identities", issuer: "https://reader.cloudflareaccess.com" },
  );
  assert.throws(() =>
    parse([
      "https://gate.example",
      "status",
      "--issuer",
      "https://reader.cloudflareaccess.com",
    ]),
  );
  assert.deepEqual(
    parse([
      "https://gate.example",
      "status",
      "--kind",
      "identities",
      "--after",
      "service:client.access",
      "--limit",
      "3",
    ]),
    {
      origin: "https://gate.example",
      command: "status",
      status: { kind: "identities", after: "service:client.access", limit: 3 },
    },
  );
  for (const tail of [
    ["--kind", "tokens"],
    ["--limit", "21"],
    ["--limit"],
    ["--after"],
    ["--limit", "2", "--limit", "3"],
    ["--secret", "value"],
    ["input.json"],
  ])
    assert.throws(() => parse(["https://gate.example", "status", ...tail]));
  assert.throws(() =>
    parse(["https://gate.example", "principal", "--kind", "principals"]),
  );
});

test("invitation CLI supports create, inspect and revoke without accepting unexpected response data", async () => {
  for (const command of ["invite", "invite-status", "invite-revoke"] as const) {
    assert.equal(
      parseAdminArguments(["https://gate.example", command, "request.json"])
        .command,
      command,
    );
    const result =
      command === "invite"
        ? {
            id: "123e4567-e89b-42d3-a456-426614174000",
            url: "https://gate.example/invite/" + "a".repeat(64),
            prompt:
              "Connect wiki4llm MCP as a web connection: https://gate.example/mcp.",
            expiresAt: Date.now() + 10000,
          }
        : command === "invite-status"
          ? {
              id: "123e4567-e89b-42d3-a456-426614174000",
              email: "person@example.org",
              issuer: "https://example.cloudflareaccess.com",
              workspaces: ["example"],
              expiresAt: Date.now() + 10000,
              status: "pending",
            }
          : { ok: true };
    assert.deepEqual(
      await adminRequest(
        "https://gate.example",
        command,
        {},
        { GATE_ACCESS_ASSERTION: "test" },
        async () => Response.json(result),
      ),
      result,
    );
    await assert.rejects(
      adminRequest(
        "https://gate.example",
        command,
        {},
        { GATE_ACCESS_ASSERTION: "test" },
        async () => Response.json({ ...result, secret: "unexpected" }),
      ),
    );
  }
});

test("invitation status preserves email addresses accepted by invitation creation", async () => {
  const result = {
    id: "123e4567-e89b-42d3-a456-426614174000",
    email: "a/b@example.org",
    issuer: "https://example.cloudflareaccess.com",
    workspaces: ["example"],
    expiresAt: Date.now() + 10000,
    status: "pending",
  };
  assert.deepEqual(
    await adminRequest(
      "https://gate.example",
      "invite-status",
      { id: result.id },
      { GATE_ACCESS_ASSERTION: "test" },
      async () => Response.json(result),
    ),
    result,
  );
});
