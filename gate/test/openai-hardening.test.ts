import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state.js";
import { OpenAIBackend } from "../src/openai.js";
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
test("forged prototype paths cannot cause provider requests", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gate-prototype-"));
  const s = new State(dir);
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const w = s.importOpenAI("docs", JSON.stringify(fixture()), binding);
  let calls = 0;
  const b = new OpenAIBackend({
    env: { SYNTHETIC_QUERY_KEY: "sk-proj-synthetic" },
    transport: async () => {
      calls++;
      return new Response(JSON.stringify({ data: [], has_more: false }));
    },
  });
  for (const [c, p] of [
    ["guide", "constructor"],
    ["guide", "__proto__"],
    ["constructor", "README.md"],
    ["__proto__", "README.md"],
  ])
    assert.equal(
      await b.read(w, c!, p!, new AbortController().signal),
      undefined,
    );
  assert.equal(calls, 0);
});
test("publication UUID cannot be reused after an intervening publication", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gate-publication-"));
  const s = new State(dir);
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const m = fixture(),
    old = m.publication_id;
  s.importOpenAI("docs", JSON.stringify(m), binding);
  m.generation++;
  m.publication_id = "7d0c9d2a-e2ad-45ce-8ff1-c736ffdaf90a";
  s.importOpenAI("docs", JSON.stringify(m), binding);
  m.generation++;
  m.publication_id = old;
  assert.throws(
    () => s.importOpenAI("docs", JSON.stringify(m), binding),
    /Publication/,
  );
});
