import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { State } from "../src/state.js";
export const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL("./fixtures/wiki-rag-manifest.json", import.meta.url),
      "utf8",
    ),
  );
export const binding = {
  projectId: "proj_test",
  credentialEnv: "SYNTHETIC_QUERY_KEY",
  stores: { guide: "vs_test", second: "vs_second" },
};
function setup(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "gate-import-"));
  const s = new State(dir);
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return s;
}
test("imports actual producer snapshot atomically and preserves no-op references across restart", (t) => {
  const s = setup(t),
    m = fixture();
  assert.equal(
    typeof s.importOpenAI,
    "function",
    "manifest import is not implemented",
  );
  const w = s.importOpenAI("docs", JSON.stringify(m), binding);
  assert.equal(w.backend, "openai");
  assert.equal(
    w.openai!.manifest.collections.second!.files["manual.pdf"]!.kind,
    "pdf",
  );
  assert.equal(
    w.openai!.manifest.collections.second!.files["README.md"]!.source_commit,
    null,
  );
  assert.equal(
    s.importOpenAI("docs", JSON.stringify(m, null, 4), binding).generation,
    w.generation,
  );
  const other = new State(s.dir);
  try {
    assert.deepEqual(other.workspace("docs"), w);
  } finally {
    other.close();
  }
  m.generation++;
  m.publication_id = "7d0c9d2a-e2ad-45ce-8ff1-c736ffdaf90a";
  assert.notEqual(
    s.importOpenAI("docs", JSON.stringify(m), binding).generation,
    w.generation,
  );
  assert.throws(
    () => s.importOpenAI("docs", JSON.stringify(fixture()), binding),
    /generation/i,
  );
});
test("invalid publications, identities, aliases and binding changes leave snapshot intact", (t) => {
  const s = setup(t);
  assert.equal(
    typeof s.importOpenAI,
    "function",
    "manifest import is not implemented",
  );
  const before = s.importOpenAI("docs", JSON.stringify(fixture()), binding);
  const mutations = [
    (m: any) => (m.schema_version = 2),
    (m: any) => (m.generation = 0),
    (m: any) => (m.published_at = null),
    (m: any) => (m.collections.guide.files["README.md"].source_commit = "bad"),
    (m: any) => (m.collections.guide.files["README.md"].sha256 = "bad"),
    (m: any) => (m.collections.guide.files["README.md"].status = "in_progress"),
    (m: any) =>
      (m.collections.guide.files["README.md"].vector_store_id = "vs_other"),
    (m: any) => (m.collections.second.files["README.md"].file_id = "file-1"),
    (m: any) => (m.collections.guide.files["README.md"].path = "../README.md"),
    (m: any) => (m.collections["bad_name"] = m.collections.guide),
    (m: any) => (m.collections.guide.repository = "/tmp/local"),
    (m: any) => (m.project_id = "proj_other"),
    (m: any) =>
      (m.collections.guide.files["bad%path.md"] = {
        ...m.collections.guide.files["README.md"],
        path: "bad%path.md",
      }),
    (m: any) => (m.publication_id = "7d0c9d2a-e2ad-45ce-8ff1-c736ffdaf90a"),
    (m: any) =>
      (m.collections.guide.files["README.md"].sha256 = "a".repeat(64)),
  ];
  for (const change of mutations) {
    const m = fixture();
    change(m);
    assert.throws(() => s.importOpenAI("docs", JSON.stringify(m), binding));
    assert.deepEqual(s.workspace("docs"), before);
  }
  assert.throws(() =>
    s.importOpenAI(
      "docs",
      JSON.stringify(fixture()).replace(
        '"schema_version":1',
        '"schema_version":1,"schema_version":1',
      ),
      binding,
    ),
  );
  assert.throws(() =>
    s.importOpenAI("docs", " ".repeat(8 * 1024 * 1024 + 1), binding),
  );
  assert.throws(() =>
    s.importOpenAI("docs", JSON.stringify(fixture()), {
      ...binding,
      credentialEnv: "OTHER_KEY",
    }),
  );
  assert.throws(() =>
    s.importOpenAI("docs", JSON.stringify(fixture()), {
      ...binding,
      credentialEnv: "OPENAI_ADMIN_KEY",
    }),
  );
  assert.throws(() =>
    s.setWorkspace("docs", [{ name: "local", path: "/tmp" }]),
  );
  assert.throws(() => s.publishGeneration("docs", "g-other"));
  s.setWorkspace("local", [{ name: "local", path: "/tmp" }]);
  assert.throws(() =>
    s.importOpenAI("local", JSON.stringify(fixture()), binding),
  );
});
