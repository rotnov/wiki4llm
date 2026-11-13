import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state.js";
import { Gateway } from "../src/gateway.js";
import { OpenAIBackend } from "../src/openai.js";
import { RoutedBackend } from "../src/router.js";
import { QmdBackend } from "../src/qmd.js";

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "gate-ranker-"));
  const state = new State(dir);
  t.after(() => {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const manifestText = readFileSync(
    new URL("./fixtures/wiki-rag-manifest.json", import.meta.url),
    "utf8",
  );
  for (const id of ["docs", "hidden"])
    state.importOpenAI(id, manifestText, {
      projectId: "proj_test",
      credentialEnv: "QUERY_KEY",
      stores: { guide: "vs_test", second: "vs_second" },
    });
  state.setWorkspace("local");
  state.publishGeneration("local", "g-local");
  state.setPrincipal("reader", { allow: ["docs", "local"], deny: [] });
  const token = state.issueToken("reader", "test", Date.now() + 60000);
  const bodies: any[] = [];
  let nativeOpens = 0;
  let onSearch = () => {};
  const cloud = new OpenAIBackend({
    env: { QUERY_KEY: "sk-proj-synthetic" },
    transport: async (url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      onSearch();
      return Response.json({
        data: [
          { file_id: "file-stale", content: [{ type: "text", text: "stale" }] },
          ...["first excerpt", "duplicate excerpt"].map((text) => ({
            file_id: url.includes("vs_test") ? "file-1" : "file-3",
            content: [{ type: "text", text }],
          })),
        ],
        has_more: true,
      });
    },
  });
  const router = new RoutedBackend(dir, cloud, async () => {
    nativeOpens++;
    throw Error("Native backend must not open");
  });
  const gateway = new Gateway(state, router);
  return {
    state,
    token,
    bodies,
    cloud,
    router,
    gateway,
    nativeOpens: () => nativeOpens,
    onSearch: (fn: () => void) => {
      onSearch = fn;
    },
  };
}

for (const [mode, weights] of [
  ["lex", { embedding_weight: 0, text_weight: 1 }],
  ["vec", { embedding_weight: 1, text_weight: 0 }],
  ["hybrid", { embedding_weight: 1, text_weight: 1 }],
] as const)
  test(`ranker omission preserves ${mode} defaults; explicit auto/none only add ranker`, async (t) => {
    const f = setup(t);
    const args = { query: "quartz", mode, limit: 5, workspaces: ["docs"] };
    const baseline = await f.gateway.execute(f.token.id, "query", args);
    const expected = {
      query: "quartz",
      max_num_results: 50,
      rewrite_query: false,
      ranking_options: { hybrid_search: weights },
    };
    assert.deepEqual(f.bodies, [expected, expected]);
    const explicitDefaults = await f.gateway.execute(f.token.id, "query", {
      ...args,
      includeSnippets: true,
    });
    assert.deepEqual(explicitDefaults, baseline);
    for (const openaiRanker of ["auto", "none"] as const) {
      f.bodies.length = 0;
      const result = await f.gateway.execute(f.token.id, "query", {
        ...args,
        openaiRanker,
      });
      assert.deepEqual(result, baseline);
      assert.deepEqual(
        f.bodies,
        [1, 2].map(() => ({
          ...expected,
          ranking_options: {
            ...expected.ranking_options,
            ranker: openaiRanker,
          },
        })),
      );
    }
    assert.equal(f.nativeOpens(), 0);
  });

test("ranker validation and complete workspace preflight perform no provider or native I/O", async (t) => {
  const f = setup(t);
  for (const openaiRanker of [null, "default-2024-11-15", "fast", 0, true, {}])
    await assert.rejects(
      f.gateway.execute(f.token.id, "query", {
        query: "q",
        workspaces: ["docs"],
        openaiRanker,
      }),
      { code: "INVALID_INPUT" },
    );
  for (const openaiRanker of ["auto", "none"] as const) {
    for (const workspaces of [
      undefined,
      ["docs", "local"],
      ["local", "docs"],
      ["local"],
    ])
      await assert.rejects(
        f.gateway.execute(f.token.id, "query", {
          query: "q",
          workspaces,
          openaiRanker,
        }),
        { code: "UNSUPPORTED_OPERATION" },
      );
    await assert.rejects(
      f.gateway.execute(f.token.id, "query", {
        query: "q",
        workspaces: ["docs", "hidden"],
        openaiRanker,
      }),
      { code: "ACCESS_DENIED" },
    );
    await assert.rejects(
      f.router.search(
        f.state.workspace("local"),
        "q",
        "lex",
        5,
        new AbortController().signal,
        { openaiRanker },
      ),
      { code: "UNSUPPORTED_OPERATION" },
    );
    // No constructor/store access is needed to reject an unsupported direct option.
    const qmd: QmdBackend = Object.create(QmdBackend.prototype);
    await assert.rejects(
      qmd.search(
        f.state.workspace("local"),
        "q",
        "lex",
        5,
        new AbortController().signal,
        { openaiRanker },
      ),
      { code: "UNSUPPORTED_OPERATION" },
    );
  }
  assert.deepEqual(f.bodies, []);
  assert.equal(f.nativeOpens(), 0);
});

for (const change of ["grant", "token", "generation", "cancel"] as const)
  test(`explicit ranker preserves final ${change} check`, async (t) => {
    const f = setup(t);
    const controller = new AbortController();
    f.onSearch(() => {
      if (change === "grant")
        f.state.setPrincipal("reader", { allow: [], deny: [] });
      if (change === "token") f.state.revokeToken(f.token.id);
      if (change === "generation") {
        const snapshot = f.state.workspace("docs").openai!;
        f.state.importOpenAI(
          "docs",
          JSON.stringify({
            ...snapshot.manifest,
            generation: 2,
            publication_id: "7d0c9d2a-e2ad-45ce-8ff1-c736ffdaf90a",
          }),
          {
            projectId: snapshot.projectId,
            credentialEnv: snapshot.credentialEnv,
            stores: snapshot.stores,
          },
        );
      }
      if (change === "cancel") controller.abort();
    });
    await assert.rejects(
      f.gateway.execute(
        f.token.id,
        "query",
        {
          query: "q",
          workspaces: ["docs"],
          openaiRanker: "none",
          includeSnippets: false,
        },
        controller.signal,
      ),
      {
        code: {
          grant: "ACCESS_DENIED",
          token: "UNAUTHENTICATED",
          generation: "CONFLICT",
          cancel: "CANCELLED",
        }[change],
      },
    );
  });

test("direct JavaScript OpenAI search rejects invalid rankers before provider I/O", async (t) => {
  const f = setup(t);
  for (const openaiRanker of [
    null,
    "",
    "fast",
    "default-2024-11-15",
    0,
    true,
    {},
    [],
  ])
    await assert.rejects(
      Reflect.apply(f.cloud.search, f.cloud, [
        f.state.workspace("docs"),
        "q",
        "hybrid",
        5,
        new AbortController().signal,
        { openaiRanker },
      ]),
      { code: "INVALID_INPUT" },
    );
  assert.deepEqual(f.bodies, []);
});
