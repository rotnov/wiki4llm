import {
  assertInputDefaults,
  assertParameterGuidance,
} from "../tool-discovery.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mcp } from "../../src/cloudflare/mcp.js";
import { Gateway } from "../../src/gateway.js";
import { OpenAIBackend } from "../../src/openai.js";

test("SDK ping preserves request IDs without invoking data handlers", async () => {
  const unused = () => assert.fail("ping must not invoke data handlers");
  const state = { context: unused, workspace: unused };
  const gateway = new Gateway(state, {
    search: unused,
    read: unused,
    status: unused,
  });
  gateway.execute = unused;
  for (const id of [0, "health-check"]) {
    const parsed = { jsonrpc: "2.0", id, method: "ping" };
    const response = await mcp(
      new Request("https://gate.example/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(parsed),
      }),
      parsed,
      state,
      gateway,
      "identity",
      new AbortController().signal,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { jsonrpc: "2.0", id, result: {} });
  }
});

test("SDK discovery sanitizes unexpected internal state failures", async () => {
  const state = {
    context() {
      throw new Error("internal database secret detail");
    },
    workspace() {
      throw new Error("internal database secret detail");
    },
  };
  const parsed = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const response = await mcp(
    new Request("https://gate.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(parsed),
    }),
    parsed,
    state,
    new Gateway(state, new OpenAIBackend({ env: {} })),
    "identity",
    new AbortController().signal,
  );
  const body = await response.text();
  assert.ok(!body.includes("internal database secret detail"));
  assert.ok(body.includes("NOT_FOUND"));
});

test("hosted SDK discovery preserves parameter guidance in schema and tool prose", async () => {
  const state = {
    context() {
      return {
        tokenId: "identity",
        principalId: "reader",
        allowed: [],
        revision: 1,
      };
    },
    workspace(): never {
      throw new Error("unused");
    },
  };
  const parsed = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const response = await mcp(
    new Request("https://gate.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(parsed),
    }),
    parsed,
    state,
    new Gateway(state, new OpenAIBackend({ env: {} })),
    "identity",
    new AbortController().signal,
  );
  assert.equal(response.status, 200);
  const body: any = await response.json();
  assertParameterGuidance(body.result.tools);
  assertInputDefaults(body.result.tools);
});
