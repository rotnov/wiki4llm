import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OpenAIBackend } from "../../src/openai.js";
import { manifestGeneration } from "../../src/manifest.js";
const m = JSON.parse(
  readFileSync(
    new URL("../fixtures/wiki-rag-manifest.json", import.meta.url),
    "utf8",
  ),
);
test("OpenAI resolves metadata-only workspace lazily without retaining snapshot", async () => {
  let calls = 0;
  const snapshot = {
    projectId: "proj_test",
    credentialEnv: "QUERY_KEY",
    stores: { guide: "vs_test", second: "vs_second" },
    manifest: m,
  };
  const backend = new OpenAIBackend({
    snapshot: () => {
      calls++;
      return snapshot;
    },
  });
  const w = {
    id: "example",
    generation: manifestGeneration(m),
    sources: [],
    backend: "openai" as const,
  };
  assert.equal(
    (await backend.status(w, new AbortController().signal)).documents,
    4,
  );
  assert.equal(calls, 1);
  assert.equal("openai" in w, false);
});
