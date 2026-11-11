import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseManifest, manifestGeneration } from "../src/manifest.js";
import { OpenAIBackend } from "../src/openai.js";
import type { Workspace } from "../src/state-contract.js";

const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL("./fixtures/wiki-rag-manifest.json", import.meta.url),
      "utf8",
    ),
  );
const binding = {
  projectId: "proj_test",
  credentialEnv: "QUERY_KEY",
  stores: { guide: "vs_test", second: "vs_second" },
};
const generated = {
  kind: "generated",
  recipe: "api",
  recipe_sha256: "a".repeat(64),
  inputs_sha256: "b".repeat(64),
};

test("manifest and MCP metadata distinguish generated files from literal Git blobs", async () => {
  const value = fixture();
  value.collections.guide.files["README.md"].origin = generated;
  const manifest = parseManifest(JSON.stringify(value), binding);
  const backend = new OpenAIBackend({
    env: { QUERY_KEY: "sk-proj-synthetic" },
    snapshot: () => ({ ...binding, manifest }),
    transport: async () =>
      Response.json({
        data: [
          {
            file_id: "file-1",
            content: [{ type: "text", text: "rendered API" }],
          },
        ],
        has_more: false,
      }),
  });
  const results = await backend.search(
    {
      id: "docs",
      backend: "openai",
      generation: manifestGeneration(manifest),
    } as Workspace,
    "API",
    "hybrid",
    5,
    new AbortController().signal,
  );
  assert.deepEqual(results[0]!.source!.origin, generated);
});

test("LFS origin requires the uploaded SHA and derived origins require a source commit", () => {
  const value = fixture(),
    file = value.collections.guide.files["README.md"];
  file.origin = { kind: "git-lfs", oid: file.sha256, size: 64 };
  assert.doesNotThrow(() => parseManifest(JSON.stringify(value), binding));
  file.origin.oid = "f".repeat(64);
  assert.throws(() => parseManifest(JSON.stringify(value), binding));
  file.origin = generated;
  file.source_commit = null;
  assert.throws(() => parseManifest(JSON.stringify(value), binding));
});

test("origin schema rejects unknown fields and unbounded generator names", () => {
  for (const origin of [
    { ...generated, secret: "not allowed" },
    { ...generated, recipe: "a".repeat(81) },
    { ...generated, inputs_sha256: "invalid" },
    { kind: "git-lfs", oid: "a".repeat(64), size: -1 },
  ]) {
    const value = fixture();
    value.collections.guide.files["README.md"].origin = origin;
    assert.throws(() => parseManifest(JSON.stringify(value), binding));
  }
});
