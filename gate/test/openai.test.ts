import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state.js";
import { Gateway, encodeReference } from "../src/gateway.js";
const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL("./fixtures/wiki-rag-manifest.json", import.meta.url),
      "utf8",
    ),
  );
const binding = {
  projectId: "proj_test",
  credentialEnv: "SYNTHETIC_QUERY_KEY",
  stores: { guide: "vs_test", second: "vs_second" },
};
const moduleUrl = "../src/openai.js";
async function backend(options: any = {}) {
  const module = await import(moduleUrl).catch(() => ({}));
  assert.equal(
    typeof module.OpenAIBackend,
    "function",
    "OpenAI backend is not implemented",
  );
  return new module.OpenAIBackend(options);
}
function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "gate-openai-"));
  const s = new State(dir);
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const w = s.importOpenAI("docs", JSON.stringify(fixture()), binding);
  s.importOpenAI("hidden", JSON.stringify(fixture()), binding);
  s.setPrincipal("reader", { allow: ["docs"], deny: [] });
  const token = s.issueToken("reader", "test", Date.now() + 60000);
  return { s, w, token };
}
function json(value: any, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
const signal = () => new AbortController().signal;
test("fixed-origin authenticated search filters active IDs, deduplicates chunks and uses canonical provenance", async (t) => {
  const { s, w, token } = setup(t);
  const requests: any[] = [];
  const b = await backend({
    env: { SYNTHETIC_QUERY_KEY: "sk-proj-synthetic" },
    transport: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      const id = url.includes("vs_test") ? "file-1" : "file-3";
      return json({
        data: [
          {
            file_id: "file-stale",
            score: 1,
            content: [{ type: "text", text: "stale" }],
          },
          {
            file_id: id,
            filename: "fake-path",
            attributes: { repository: "foreign" },
            score: 0.8,
            content: [{ type: "text", text: "quartz snippet" }],
          },
          {
            file_id: id,
            score: 0.7,
            content: [{ type: "text", text: "duplicate" }],
          },
          {
            file_id: url.includes("vs_test") ? "file-3" : "file-1",
            score: 0.6,
            content: [{ type: "text", text: "foreign" }],
          },
        ],
        has_more: true,
        next_page: "ignored",
      });
    },
  });
  const g = new Gateway(s, b);
  const result: any = await g.execute(token.id, "query", { query: "quartz" });
  assert.equal(result.results.length, 2);
  assert.deepEqual(
    result.results.map((r: any) => r.path),
    ["README.md", "README.md"],
  );
  assert.deepEqual(
    new Set(result.results.map((r: any) => r.source.repository)),
    new Set(["example/guide", "example/second"]),
  );
  assert.equal(result.results[0].source.kind, "openai");
  assert.equal(
    result.results[0].snippet,
    "quartz snippet\n\n--- excerpt ---\n\nduplicate",
  );
  assert.equal(requests.length, 2);
  for (const r of requests) {
    assert.ok(r.url.startsWith("https://api.openai.com/v1/vector_stores/"));
    assert.equal(r.init.redirect, "error");
    assert.equal(r.init.headers["OpenAI-Project"], "proj_test");
    assert.equal(r.init.headers.Authorization, "Bearer sk-proj-synthetic");
    assert.deepEqual(JSON.parse(r.init.body).ranking_options.hybrid_search, {
      embedding_weight: 1,
      text_weight: 1,
    });
  }
  for (const [mode, weights] of [
    ["lex", [0, 1]],
    ["vec", [1, 0]],
  ] as const) {
    await b.search(w, "quartz", mode, 2, signal());
    const control = JSON.parse(requests.at(-1).init.body).ranking_options
      .hybrid_search;
    assert.deepEqual([control.embedding_weight, control.text_weight], weights);
  }
  const n = requests.length;
  for (const [tool, args] of [
    ["query", { query: "q", workspaces: ["hidden"] }],
    ["query", { query: "q", project_id: "proj_other" }],
    [
      "get",
      { ref: encodeReference("hidden", w.generation!, "guide", "README.md") },
    ],
    [
      "multi_get",
      {
        refs: [
          result.results[0].ref,
          encodeReference("hidden", w.generation!, "guide", "README.md"),
        ],
      },
    ],
  ] as const)
    await assert.rejects(g.execute(token.id, tool, args));
  assert.equal(requests.length, n);
  assert.deepEqual(await b.status(w, signal()), {
    documents: 4,
    vectors: null,
    backend: "openai",
  });
});
test("get resolves active mapping and refuses unqualified parsed-content pagination", async (t) => {
  const { w } = setup(t);
  const calls: string[] = [];
  const b = await backend({
    env: { SYNTHETIC_QUERY_KEY: "sk-proj-synthetic" },
    transport: async (url: string) => {
      calls.push(url);
      return json(
        url.includes("after=")
          ? {
              data: [{ type: "text", text: "second line" }],
              has_more: false,
              next_page: null,
            }
          : {
              data: [{ type: "text", text: "first line" }],
              has_more: true,
              next_page: "cursor-1",
            },
      );
    },
  });
  assert.equal(await b.read(w, "guide", "missing.md", signal()), undefined);
  assert.equal(calls.length, 0);
  await assert.rejects(
    b.read(w, "second", "manual.pdf", signal()),
    /pagination/i,
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.endsWith("/vs_second/files/file-4/content"));
  const complete = await backend({
    env: { SYNTHETIC_QUERY_KEY: "sk-proj-synthetic" },
    transport: async () =>
      json({
        data: [
          { type: "text", text: "first line" },
          { type: "text", text: "second line" },
        ],
        has_more: false,
      }),
  });
  const d = await complete.read(w, "second", "manual.pdf", signal());
  assert.equal(d.body, "first line\nsecond line");
  assert.equal(d.source.lineBasis, "parsed-text");
  for (const value of [
    { data: [{ type: "image", text: "bad" }], has_more: false },
    { data: [], has_more: true, next_page: null },
    { data: [], has_more: true, next_page: "repeat" },
  ]) {
    const bad = await backend({
      env: { SYNTHETIC_QUERY_KEY: "sk-proj-synthetic" },
      transport: async () => json(value),
    });
    await assert.rejects(
      bad.read(w, "guide", "README.md", signal()),
      /content|response|pagination/i,
    );
  }
});
test("missing credentials, permission errors, redirects, response bounds and aborts are sanitized", async (t) => {
  const { w } = setup(t);
  let calls = 0;
  for (const env of [
    {},
    { SYNTHETIC_QUERY_KEY: "secret\r\nheader" },
    { SYNTHETIC_QUERY_KEY: "sk-admin-secret" },
  ]) {
    const b = await backend({
      env,
      transport: async () => {
        calls++;
        throw Error("should not call");
      },
    });
    await assert.rejects(b.search(w, "q", "lex", 2, signal()));
  }
  assert.equal(calls, 0);
  for (const response of [
    () => json({ error: { message: "sk-proj-secret body" } }, 403),
    () =>
      new Response("redirect", {
        status: 302,
        headers: { Location: "https://evil.invalid" },
      }),
    () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    () => json({ data: "invalid", has_more: false }),
  ]) {
    const b = await backend({
      env: { SYNTHETIC_QUERY_KEY: "sk-proj-secret" },
      transport: async () => response(),
    });
    await assert.rejects(
      b.search(w, "q", "lex", 2, signal()),
      (e: any) => !String(e).includes("sk-proj-secret"),
    );
  }
  const slow = await backend({
    env: { SYNTHETIC_QUERY_KEY: "sk-proj-synthetic" },
    timeoutMs: 20,
    transport: async () => new Promise(() => {}),
  });
  await assert.rejects(
    slow.search(w, "q", "lex", 2, signal()),
    /deadline|cancel/i,
  );
  const controller = new AbortController();
  controller.abort();
  const b = await backend({
    env: { SYNTHETIC_QUERY_KEY: "sk-proj-synthetic" },
    transport: async () => {
      calls++;
      return json({});
    },
  });
  await assert.rejects(b.search(w, "q", "lex", 2, controller.signal));
  assert.equal(calls, 0);
});
test("in-flight publication, permission and credential revocation prevent delivery", async (t) => {
  for (const change of ["publication", "permission", "token"]) {
    const { s, token } = setup(t);
    let release: () => void = () => {};
    let started: () => void = () => {};
    const waiting = new Promise<void>((r) => (started = r));
    const pending = new Promise<void>((r) => (release = r));
    const b = await backend({
      env: { SYNTHETIC_QUERY_KEY: "sk-proj-synthetic" },
      transport: async () => {
        started();
        await pending;
        return json({ data: [], has_more: false });
      },
    });
    const g = new Gateway(s, b);
    const op = g.execute(token.id, "query", { query: "q" });
    await waiting;
    if (change === "publication") {
      const m = fixture();
      m.generation++;
      m.publication_id = "7d0c9d2a-e2ad-45ce-8ff1-c736ffdaf90a";
      s.importOpenAI("docs", JSON.stringify(m), binding);
    } else if (change === "permission")
      s.setPrincipal("reader", { allow: [], deny: [] });
    else s.revokeToken(token.id);
    release();
    await assert.rejects(op);
  }
});

test("search stays within the provider's 50-result maximum", async (t) => {
  const { w } = setup(t);
  const b = await backend({
    env: { SYNTHETIC_QUERY_KEY: "sk-proj-synthetic" },
    transport: async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.max_num_results > 50)
        return json({ error: "provider result bound" }, 400);
      return json({ data: [], has_more: false });
    },
  });
  assert.deepEqual(await b.search(w, "quartz", "hybrid", 20, signal()), []);
});
