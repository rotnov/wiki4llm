import { assertParameterGuidance } from "./tool-discovery.js";
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
      ["list_workspaces", "query", "get", "multi_get", "status"],
    );
    assertParameterGuidance((await client.listTools()).tools);
    const result: any = await client.callTool({
      name: "list_workspaces",
      arguments: {},
    });
    assert.deepEqual(
      result.structuredContent.workspaces.map((w: any) => w.id),
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
