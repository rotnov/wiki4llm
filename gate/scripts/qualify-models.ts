import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { State } from "../src/state.js";
import { QmdBackend } from "../src/qmd.js";
import { acquireLease } from "../src/lease.js";
process.umask(0o077);
const root = resolve(".data/qualification-docs");
mkdirSync(root, { recursive: true });
writeFileSync(
  join(root, "readme.md"),
  "# Synthetic gate qualification\nQuartz optics for a synthetic local test. No production documents.\n",
);
const state = new State(".data/qualification"),
  release = acquireLease(state.dir);
let backend: QmdBackend | undefined;
try {
  backend = await QmdBackend.open(state.dir);
  for (const id of ["qualification", "qualification-two"]) {
    state.setWorkspace(id, [{ name: "docs", path: root }]);
    state.publishGeneration(id, await backend.index(state.workspace(id), true));
  }
  const signal = new AbortController().signal,
    results = [];
  for (const mode of ["vec", "hybrid"] as const) {
    const { hits } = await backend.search(
      state.workspace("qualification"),
      "quartz optics",
      mode,
      2,
      signal,
    );
    assert.equal(hits.length, 1);
    results.push({ mode, results: hits.length });
  }
  await backend.search(
    state.workspace("qualification-two"),
    "quartz optics",
    "vec",
    2,
    signal,
  );
  assert.equal(backend.runtimeCount, 1);
  console.log(
    JSON.stringify(
      {
        date: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        syntheticWorkspaces: 2,
        sharedRuntimeIdentityCount: backend.runtimeCount,
        results,
        status: await backend.status(state.workspace("qualification"), signal),
        gpuMemoryMeasured: false,
      },
      null,
      2,
    ),
  );
} finally {
  await backend?.close();
  release();
  state.close();
}
