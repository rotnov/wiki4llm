import { toolPayload } from "./tool-payload.js";
import {
  assertInputDefaults,
  assertParameterGuidance,
} from "./tool-discovery.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { State } from "../src/state.js";
import { Gateway } from "../src/gateway.js";
import { startServer } from "../src/http.js";

test("native HTTP ping authenticates and returns empty SDK results without data access", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-http-ping-"));
  const state = new State(dir);
  state.setPrincipal("reader", { allow: [], deny: [] });
  const token = state.issueToken("reader", "ping", Date.now() + 60000, {
    allow: [],
    deny: [],
  });
  const unused = () => assert.fail("ping must not invoke data handlers");
  const gateway = new Gateway(state, {
    search: unused,
    read: unused,
    status: unused,
  });
  gateway.execute = unused;
  const server = await startServer(state, gateway, 0);
  try {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    for (const id of [0, "health-check"]) {
      const body = JSON.stringify({ jsonrpc: "2.0", id, method: "ping" });
      assert.equal(
        (await fetch(server.url, { method: "POST", headers, body })).status,
        401,
      );
      const result = await fetch(server.url, {
        method: "POST",
        headers: { ...headers, Authorization: `Bearer ${token.secret}` },
        body,
      });
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), { jsonrpc: "2.0", id, result: {} });
      assert.equal(result.headers.get("mcp-session-id"), null);
    }
    const authenticated = {
      ...headers,
      Authorization: `Bearer ${token.secret}`,
    };
    assert.equal(
      (await fetch(server.url, { headers: authenticated })).status,
      405,
    );
    for (const body of [
      { jsonrpc: "2.0", id: 0, method: "unknown" },
      { jsonrpc: "1.0", id: 0, method: "ping" },
      { jsonrpc: "2.0", id: null, method: "ping" },
      { jsonrpc: "2.0", id: 0, method: "ping", params: "invalid" },
      [{ jsonrpc: "2.0", id: 0, method: "ping" }],
    ]) {
      const result = await fetch(server.url, {
        method: "POST",
        headers: authenticated,
        body: JSON.stringify(body),
      });
      assert.equal(result.status, 400);
    }
  } finally {
    await server.close();
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("official MCP client authenticates each request, scopes tools, and cannot reuse a session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-http-")),
    s = new State(dir);
  s.setWorkspace("amplifier");
  s.setWorkspace("dsx");
  s.setPrincipal("p", { allow: ["*"], deny: [] });
  const t = s.issueToken("p", "test", Date.now() + 60000, {
    allow: ["amplifier"],
    deny: [],
  });
  const g = new Gateway(s, {
    async search() {
      return [];
    },
    async read() {
      return undefined;
    },
    async status() {
      return { documents: 0, vectors: 0 };
    },
  });
  const server = await startServer(s, g, 0);
  const url = new URL(server.url);
  const client = new Client({ name: "test", version: "1" });
  try {
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    const headers = { Authorization: `Bearer ${t.secret}` };
    for (const extra of [
      { "Mcp-Session-Id": "foreign" },
      { Origin: "https://evil.example" },
    ])
      assert.equal(
        (
          await fetch(url, {
            method: "POST",
            headers: { ...headers, ...extra },
          })
        ).status,
        403,
      );
    assert.equal(
      await new Promise((resolve) => {
        const r = request(
          url,
          { method: "POST", headers: { ...headers, Host: "evil.example" } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        r.end();
      }),
      403,
    );
    assert.equal(
      (await fetch(url, { method: "POST", headers, body: "x".repeat(131073) }))
        .status,
      413,
    );
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
    );
    assert.equal(client.getServerVersion()?.name, "wiki-rag-gate");
    assert.deepEqual(
      (await client.listTools()).tools.map((t) => t.name),
      [
        "list_workspaces",
        "query",
        "find_documents",
        "get",
        "multi_get",
        "status",
      ],
    );
    assertParameterGuidance((await client.listTools()).tools);
    assertInputDefaults((await client.listTools()).tools);
    const result: any = await client.callTool({
      name: "list_workspaces",
      arguments: {},
    });
    assert.deepEqual(
      toolPayload(result).workspaces.map((w: any) => w.id),
      ["amplifier"],
    );
    const denied: any = await client.callTool({
      name: "status",
      arguments: { workspaces: ["dsx"] },
    });
    assert.equal(denied.isError, true);
    await assert.rejects(client.listResources());
    s.revokeToken(t.id);
    await assert.rejects(client.listTools());
  } finally {
    await client.close();
    await server.close();
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("container bind accepts only explicitly configured authorities and still requires a token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-container-http-"));
  const state = new State(dir);
  const gateway = new Gateway(state, {
    async search() {
      return [];
    },
    async read() {
      return undefined;
    },
    async status() {
      return { documents: 0, vectors: 0 };
    },
  });
  const server = await startServer(state, gateway, 0, {
    bindHost: "0.0.0.0",
    allowedHosts: ["gate.test:8787"],
  });
  const probe = (host: string) =>
    new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        server.url,
        { method: "POST", headers: { Host: host } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    assert.equal(await probe("gate.test:8787"), 401);
    assert.equal(await probe("evil.example"), 403);
    assert.equal(await probe("gate.test.evil.example:8787"), 403);
  } finally {
    await server.close();
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
