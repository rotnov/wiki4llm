import { toolPayload } from "./tool-payload.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { State } from "../src/state.js";
import { Gateway } from "../src/gateway.js";
import { OpenAIBackend } from "../src/openai.js";
import { startServer } from "../src/http.js";
const manifestPath = new URL(
  "./fixtures/wiki-rag-manifest.json",
  import.meta.url,
);
const fixture = () => JSON.parse(readFileSync(manifestPath, "utf8"));
const binding = {
  projectId: "proj_test",
  credentialEnv: "SYNTHETIC_QUERY_KEY",
  stores: { guide: "vs_test", second: "vs_second" },
};
test("operator import CLI validates pinned mappings without native runtime", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gate-import-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const args = [
    "--import",
    "tsx",
    "src/cli.ts",
    "import-openai",
    "--state",
    dir,
    "--id",
    "docs",
    "--manifest",
    manifestPath.pathname,
    "--project",
    "proj_test",
    "--credential-env",
    "SYNTHETIC_QUERY_KEY",
    "--store",
    "guide=vs_test",
    "--store",
    "second=vs_second",
  ];
  const out = execFileSync(process.execPath, args, { encoding: "utf8" });
  assert.match(out, /Imported docs/);
  const s = new State(dir);
  try {
    assert.equal(s.workspace("docs").backend, "openai");
  } finally {
    s.close();
  }
  assert.throws(() =>
    execFileSync(process.execPath, [...args, "--store", "guide=vs_test"], {
      stdio: "pipe",
    }),
  );
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "index",
        "--state",
        dir,
        "--id",
        "docs",
      ],
      { stdio: "pipe" },
    ),
  );
});
test("official MCP SDK consumes producer fixture with lazy mixed backends, persistent imports and stale reference rejection", async (t) => {
  const moduleUrl = "../src/router.js";
  const m = await import(moduleUrl).catch(() => ({}));
  assert.equal(
    typeof m.RoutedBackend,
    "function",
    "routed backend is not implemented",
  );
  const dir = mkdtempSync(join(tmpdir(), "gate-openai-sdk-"));
  const s = new State(dir);
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  s.importOpenAI("docs", JSON.stringify(fixture()), binding);
  s.setWorkspace("local");
  s.publishGeneration("local", "g-local");
  s.setPrincipal("reader", { allow: ["*"], deny: [] });
  const token = s.issueToken("reader", "test", Date.now() + 60000);
  let opens = 0,
    closes = 0,
    requests = 0;
  const cloud = new OpenAIBackend({
    env: { SYNTHETIC_QUERY_KEY: "sk-proj-synthetic" },
    transport: async (url) => {
      requests++;
      return new Response(
        JSON.stringify(
          url.endsWith("/search")
            ? {
                data: [
                  {
                    file_id: url.includes("vs_test") ? "file-1" : "file-3",
                    score: 1,
                    content: [{ type: "text", text: "synthetic quartz" }],
                  },
                ],
                has_more: false,
              }
            : {
                data: [{ type: "text", text: "parsed quartz\nsecond line" }],
                has_more: false,
              },
        ),
      );
    },
  });
  const router = new m.RoutedBackend(dir, cloud, async () => {
    opens++;
    return {
      async search() {
        return [
          {
            collection: "local",
            path: "README.md",
            title: "Local",
            body: "local quartz",
            score: 1,
          },
        ];
      },
      async read() {
        return undefined;
      },
      async status() {
        return { documents: 1, vectors: 0 };
      },
      async close() {
        closes++;
      },
    };
  });
  const server = await startServer(s, new Gateway(s, router), 0);
  const client = new Client({ name: "synthetic-openai-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: "Bearer " + token.secret } },
      }),
    );
    assert.equal((await client.listTools()).tools.length, 6);
    const call = async (name: string, args: any = {}) =>
      (await client.callTool({ name, arguments: args })) as any;
    const first = await call("query", {
      query: "quartz",
      workspaces: ["docs"],
    });
    assert.equal(first.isError, undefined);
    assert.equal(toolPayload(first).results.length, 2);
    assert.equal(opens, 0);
    const ref = toolPayload(first).results[0].ref;
    const got = await call("get", { ref });
    assert.equal(toolPayload(got).source.lineBasis, "parsed-text");
    assert.equal(toolPayload(got).totalLines, 2);
    const status = await call("status", { workspaces: ["docs"] });
    assert.equal(toolPayload(status).workspaces[0].vectors, null);
    const other = new State(dir);
    try {
      other.importOpenAI("docs", JSON.stringify(fixture()), binding);
      assert.equal((await call("get", { ref })).isError, undefined);
      const updated = fixture();
      updated.generation++;
      updated.publication_id = "7d0c9d2a-e2ad-45ce-8ff1-c736ffdaf90a";
      other.importOpenAI("docs", JSON.stringify(updated), binding);
    } finally {
      other.close();
    }
    const n = requests;
    assert.equal((await call("get", { ref })).isError, true);
    assert.equal(requests, n);
    const mixed = await call("query", { query: "quartz" });
    assert.equal(toolPayload(mixed).results.length, 3);
    assert.equal(opens, 1);
    assert.equal(
      toolPayload(mixed).results.find((r: any) => r.workspace === "local")
        .source.kind,
      "local",
    );
    const metadata = toolPayload(
      await call("query", { query: "quartz", includeSnippets: false }),
    );
    assert.deepEqual(metadata, {
      ...toolPayload(mixed),
      results: toolPayload(mixed).results.map(
        ({ snippet: _snippet, ...rest }: any) => rest,
      ),
      snippetsIncluded: false,
    });
    s.revokeToken(token.id);
    await assert.rejects(client.listTools());
  } finally {
    await client.close();
    await server.close();
    await router.close();
  }
  assert.equal(closes, 1);
});
