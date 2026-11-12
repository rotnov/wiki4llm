import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { State } from "../src/state.js";
import { Gateway, parseReference } from "../src/gateway.js";
import { OpenAIBackend } from "../src/openai.js";
import { RoutedBackend } from "../src/router.js";
import { GateError } from "../src/errors.js";
import { mcp } from "../src/cloudflare/mcp.js";
import { startServer } from "../src/http.js";
import { toolPayload } from "./tool-payload.js";
import { assertParameterGuidance } from "./tool-discovery.js";
const binding = {
  projectId: "proj_test",
  credentialEnv: "QUERY_KEY",
  stores: { guide: "vs_test", second: "vs_second" },
};
function fixture() {
  return JSON.parse(
    readFileSync(
      new URL("./fixtures/wiki-rag-manifest.json", import.meta.url),
      "utf8",
    ),
  );
}
function files(manifest: any, collection: string, paths: string[]) {
  const c = manifest.collections[collection],
    template = Object.values(c.files)[0] as any;
  c.files = Object.fromEntries(
    paths.map((path, i) => [
      path,
      { ...template, path, kind: "md", file_id: `file-${collection}-${i}` },
    ]),
  );
}
function setup(t: any, manifest = fixture()) {
  const dir = mkdtempSync(join(tmpdir(), "find-documents-")),
    state = new State(dir);
  t.after(() => {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const w = state.importOpenAI("docs", JSON.stringify(manifest), binding);
  state.importOpenAI("hidden", JSON.stringify(manifest), binding);
  state.setWorkspace("local");
  state.publishGeneration("local", "g-local");
  state.setPrincipal("reader", { allow: ["docs", "local"], deny: [] });
  const token = state.issueToken("reader", "test", Date.now() + 60000),
    calls: string[] = [];
  const backend = new OpenAIBackend({
    env: { QUERY_KEY: "sk-synthetic00" },
    transport: async (url) => {
      calls.push(url);
      return Response.json({
        data: [{ type: "text", text: "README.md mentioned in body" }],
        has_more: false,
      });
    },
  });
  const gateway = new Gateway(state, backend);
  const find = (args: any = {}) =>
    gateway.execute(token.id, "find_documents", {
      workspace: "docs",
      query: "README.md",
      ...args,
    }) as Promise<any>;
  return { dir, state, token, w, backend, gateway, calls, find, manifest };
}
test("literal metadata discovery ranks full basenames, keeps distinct identities and never reads bodies", async (t) => {
  const m = fixture();
  files(m, "guide", [
    "README.md/guide.md",
    "b/README.md",
    "a/Readme.md",
    "prefix-README.md",
    "Dataset_Card.md",
    "literal[1]*?.md",
    "mention.md",
  ]);
  files(m, "second", ["a/Readme.md"]);
  const f = setup(t, m),
    result = await f.find({ query: "  rEaDmE.md  ", limit: 20 });
  assert.deepEqual(
    result.results.map((d: any) => [d.source.repository, d.path]),
    [
      ["example/guide", "a/Readme.md"],
      ["example/guide", "b/README.md"],
      ["example/second", "a/Readme.md"],
      ["example/guide", "prefix-README.md"],
      ["example/guide", "README.md/guide.md"],
    ],
  );
  assert.equal(result.hasMore, false);
  assert.deepEqual(await f.find({ query: "dataset-card" }), {
    results: [],
    hasMore: false,
  });
  assert.equal(
    (await f.find({ query: "literal[1]*?" })).results[0].path,
    "literal[1]*?.md",
  );
  assert.equal((await f.find({ query: "readme guide" })).results.length, 0);
  assert.equal(f.calls.length, 0);
  for (const d of result.results) {
    assert.deepEqual(Object.keys(d).sort(), [
      "collection",
      "generation",
      "path",
      "ref",
      "source",
      "title",
      "workspace",
    ]);
    assert.equal(d.source.lineBasis, "none");
    assert.deepEqual(parseReference(d.ref), {
      workspace: "docs",
      generation: f.w.generation,
      collection: d.collection,
      path: d.path,
    });
  }
});
test("ties use code-unit repository, collection and path order without Unicode normalization", async (t) => {
  const m = fixture();
  m.collections.second.repository = "example/guide";
  files(m, "guide", [
    "a/README.md",
    "Z/README.md",
    "Caf\u00e9.md",
    "Cafe\u0301.md",
    ...Array.from({ length: 30 }, (_, i) => `mention-${i}.md`),
  ]);
  files(m, "second", ["A/README.md"]);
  const f = setup(t, m);
  assert.deepEqual(
    (await f.find()).results.map((d: any) => d.path),
    ["Z/README.md", "a/README.md", "A/README.md"],
  );
  assert.deepEqual(
    (await f.find({ query: "caf\u00e9" })).results.map((d: any) => d.path),
    ["Caf\u00e9.md"],
  );
  assert.equal(f.calls.length, 0);
});
test("repository filter precedes rank and limit; default/max bounds and hasMore are exact", async (t) => {
  const m = fixture();
  files(
    m,
    "guide",
    Array.from(
      { length: 21 },
      (_, i) => `nested-${String(i).padStart(2, "0")}/README.md`,
    ),
  );
  files(m, "second", ["README.md"]);
  const f = setup(t, m),
    first = await f.find();
  assert.equal(first.results.length, 5);
  assert.equal(first.hasMore, true);
  assert.deepEqual(await f.find(), first);
  const capped = await f.find({ limit: 20 });
  assert.equal(capped.results.length, 20);
  assert.equal(capped.hasMore, true);
  assert.ok(
    capped.results.every((d: any) => d.source.repository === "example/guide"),
  );
  const target = await f.find({ repository: "example/second" });
  assert.equal(target.results.length, 1);
  assert.equal(target.results[0].path, "README.md");
  assert.equal(target.hasMore, false);
  for (const repository of [
    "Example/second",
    "example/*",
    " example/second",
    "unknown",
  ])
    assert.deepEqual(await f.find({ repository }), {
      results: [],
      hasMore: false,
    });
  assert.equal(f.calls.length, 0);
});
test("display cap does not clip refs, paths, provenance or full-basename ranking", async (t) => {
  const m = fixture(),
    long = "a".repeat(510) + ".md";
  files(m, "guide", ["prefix-" + long, long]);
  const original = m.collections.guide.files[long];
  original.origin = { kind: "git-lfs", oid: original.sha256, size: 123 };
  const f = setup(t, m),
    d = (await f.find({ query: long })).results[0];
  assert.equal(d.path, long);
  assert.equal(d.title, long.slice(0, 500));
  assert.equal(parseReference(d.ref).path, long);
  assert.deepEqual(d.source, {
    kind: "openai",
    repository: "example/guide",
    path: long,
    sourceCommit: original.source_commit,
    repositoryCommit: m.collections.guide.repository_commit,
    publicationId: m.publication_id,
    sha256: original.sha256,
    fileKind: "md",
    lineBasis: "none",
    origin: original.origin,
  });
  const second = (await f.find({ repository: "example/second" })).results[0];
  assert.equal(second.source.sourceCommit, null);
  assert.equal(second.source.repositoryCommit, null);
});
test("invalid discovery input and unauthorized workspaces never reach the backend", async (t) => {
  const f = setup(t);
  for (const args of [
    { query: "" },
    { query: " \t " },
    { query: "x".repeat(1025) },
    { workspace: ["docs"] },
    { workspace: "*" },
    { workspace: "" },
    { limit: 0 },
    { limit: 21 },
    { limit: 1.5 },
    { limit: "5" },
    { extra: true },
    ...[
      "",
      "/example",
      "x\\y",
      "x//y",
      "x/./y",
      "x/../y",
      "x\ny",
      "x".repeat(257),
    ].map((repository) => ({ repository })),
  ])
    await assert.rejects(f.find(args), { code: "INVALID_INPUT" });
  for (const workspace of ["hidden", "missing"])
    await assert.rejects(f.find({ workspace }), { code: "ACCESS_DENIED" });
  assert.equal(f.calls.length, 0);
});
test("optional capability and QMD fail without initializing native; closed router stays closed", async (t) => {
  const f = setup(t),
    incapable = {
      search: f.backend.search.bind(f.backend),
      read: f.backend.read.bind(f.backend),
      status: f.backend.status.bind(f.backend),
    };
  await assert.rejects(
    new Gateway(f.state, incapable).execute(f.token.id, "find_documents", {
      workspace: "docs",
      query: "README",
    }),
    { code: "UNSUPPORTED_OPERATION" },
  );
  const missing = new RoutedBackend(f.dir, incapable);
  await assert.rejects(
    new Gateway(f.state, missing).execute(f.token.id, "find_documents", {
      workspace: "docs",
      query: "README",
    }),
    { code: "UNSUPPORTED_OPERATION" },
  );
  await missing.close();
  let opens = 0;
  const router = new RoutedBackend(f.dir, f.backend, async () => {
      opens++;
      throw Error("must not open");
    }),
    gateway = new Gateway(f.state, router);
  await assert.rejects(
    gateway.execute(f.token.id, "find_documents", {
      workspace: "local",
      query: "README",
    }),
    { code: "UNSUPPORTED_OPERATION" },
  );
  assert.equal(opens, 0);
  assert.equal(
    (
      (await gateway.execute(f.token.id, "find_documents", {
        workspace: "docs",
        query: "README",
      })) as any
    ).results.length,
    2,
  );
  await router.close();
  for (const workspace of ["docs", "local"])
    await assert.rejects(
      gateway.execute(f.token.id, "find_documents", {
        workspace,
        query: "README",
      }),
      { code: "NOT_FOUND" },
    );
  assert.equal(opens, 0);
});
test("hosted snapshot callback works without embedded state or query credentials", async (t) => {
  const f = setup(t),
    { openai, ...workspace } = f.w;
  let snapshots = 0;
  const backend = new OpenAIBackend({
    env: {},
    snapshot: () => {
      snapshots++;
      return openai!;
    },
    transport: async () => {
      throw Error("provider forbidden");
    },
  });
  const state = {
    context: f.state.context.bind(f.state),
    workspace: () => workspace,
  };
  const result: any = await new Gateway(state, backend).execute(
    f.token.id,
    "find_documents",
    { workspace: "docs", query: "README.md" },
  );
  assert.equal(result.results.length, 2);
  assert.equal(snapshots, 1);
});
for (const surface of ["gateway", "hosted"] as const)
  for (const failure of [false, true])
    for (const change of ["grant", "token", "generation", "cancel"] as const)
      test(`${surface} discovery ${failure ? "error" : "success"} revalidates ${change} before delivery`, async (t) => {
        const f = setup(t),
          abort = new AbortController();
        const backend = new OpenAIBackend({
          snapshot: () => {
            if (change === "grant")
              f.state.setPrincipal("reader", { allow: [], deny: [] });
            if (change === "token") f.state.revokeToken(f.token.id);
            if (change === "generation") {
              f.manifest.generation++;
              f.manifest.publication_id = crypto.randomUUID();
              f.state.importOpenAI("docs", JSON.stringify(f.manifest), binding);
            }
            if (change === "cancel") abort.abort();
            if (failure)
              throw new GateError(
                "UNSUPPORTED_OPERATION",
                "private diagnostic",
              );
            return f.w.openai!;
          },
        });
        const gateway = new Gateway(f.state, backend),
          args = { workspace: "docs", query: "README" };
        const code = {
          grant: "ACCESS_DENIED",
          token: "UNAUTHENTICATED",
          generation: "CONFLICT",
          cancel: "CANCELLED",
        }[change];
        if (surface === "gateway") {
          await assert.rejects(
            gateway.execute(f.token.id, "find_documents", args, abort.signal),
            { code },
          );
        } else {
          const parsed = {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "find_documents", arguments: args },
          };
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
            f.state,
            gateway,
            f.token.id,
            abort.signal,
          );
          const envelope: any = await response.json();
          assert.deepEqual(envelope.result, {
            isError: true,
            content: [{ type: "text", text: code }],
          });
          for (const value of [
            "private diagnostic",
            "UNSUPPORTED_OPERATION",
            "qgdoc:",
            "README.md",
            "file-",
            "vs_test",
          ])
            assert.ok(!JSON.stringify(envelope).includes(value));
        }
      });
test("native SDK advertises discovery, emits one JSON text and accepts refs for both read tools", async (t) => {
  const f = setup(t),
    server = await startServer(f.state, f.gateway, 0),
    client = new Client({ name: "metadata-test", version: "1" });
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${f.token.secret}` } },
    }),
  );
  assertParameterGuidance((await client.listTools()).tools);
  const wire = CallToolResultSchema.parse(
    await client.callTool({
      name: "find_documents",
      arguments: { workspace: "docs", query: "README.md" },
    }),
  );
  assert.equal(wire.structuredContent, undefined);
  assert.equal(wire.content.length, 1);
  const result = toolPayload(wire);
  assert.equal(result.results.length, 2);
  assert.equal(f.calls.length, 0);
  const ref = result.results[0].ref;
  assert.equal(
    toolPayload(
      CallToolResultSchema.parse(
        await client.callTool({ name: "get", arguments: { ref } }),
      ),
    ).text,
    "README.md mentioned in body",
  );
  assert.equal(
    toolPayload(
      CallToolResultSchema.parse(
        await client.callTool({
          name: "multi_get",
          arguments: { refs: [ref] },
        }),
      ),
    ).documents.length,
    1,
  );
  const before = f.calls.length;
  f.manifest.generation++;
  f.manifest.publication_id = crypto.randomUUID();
  f.state.importOpenAI("docs", JSON.stringify(f.manifest), binding);
  const stale: any = await client.callTool({ name: "get", arguments: { ref } });
  assert.equal(stale.isError, true);
  assert.equal(stale.content[0].text, "NOT_FOUND");
  f.state.setPrincipal("reader", { allow: [], deny: [] });
  const denied: any = await client.callTool({
    name: "find_documents",
    arguments: { workspace: "docs", query: "README" },
  });
  assert.equal(denied.isError, true);
  assert.equal(denied.content[0].text, "ACCESS_DENIED");
  assert.equal(f.calls.length, before);
});
test("metadata output budget errors without clipping paths or returning partial results", async (t) => {
  const m = fixture();
  files(
    m,
    "guide",
    Array.from(
      { length: 20 },
      (_, i) => `${i}/` + "\u754c".repeat(1000) + ".md",
    ),
  );
  const f = setup(t, m);
  await assert.rejects(f.find({ query: "\u754c", limit: 20 }), {
    code: "CONTENT_TOO_LARGE",
  });
  assert.equal((await f.find({ query: "\u754c", limit: 1 })).results.length, 1);
  assert.equal(f.calls.length, 0);
});
