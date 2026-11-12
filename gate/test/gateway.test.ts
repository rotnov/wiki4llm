import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state.js";
import { Gateway, encodeReference, parseReference } from "../src/gateway.js";
import type { Backend, Document } from "../src/backend.js";
async function fixture(
  fn: (
    s: State,
    g: Gateway,
    tokenId: string,
    calls: string[],
    backend: Backend,
  ) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "qmd-gate-"));
  const s = new State(dir);
  const calls: string[] = [];
  const doc: Document = {
    collection: "docs",
    path: "readme.md",
    title: "Shared title",
    body: "Shared text",
  };
  const backend: Backend = {
    async search(w) {
      calls.push(w.id);
      return [{ ...doc, score: 99 }];
    },
    async read(w, _c, path) {
      calls.push(w.id);
      return path === "readme.md" ? doc : undefined;
    },
    async status(w) {
      calls.push(w.id);
      return { documents: 1, vectors: 1 };
    },
  };
  try {
    for (const id of ["amplifier", "dsx"]) {
      s.setWorkspace(id);
      s.publishGeneration(id, "generation-1");
    }
    s.setPrincipal("p", { allow: ["amplifier"], deny: [] });
    const t = s.issueToken("p", "test", Date.now() + 60000);
    await fn(s, new Gateway(s, backend), t.id, calls, backend);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const args = { query: "Shared", mode: "lex" };
test("a query with no selector only searches authorized workspaces", () =>
  fixture(async (_s, g, t, calls) => {
    const r: any = await g.execute(t, "query", args);
    assert.deepEqual(calls, ["amplifier"]);
    assert.equal(r.results[0].workspace, "amplifier");
  }));
test("forbidden and mixed explicit queries never reach a backend", () =>
  fixture(async (_s, g, t, calls) => {
    await assert.rejects(
      g.execute(t, "query", { ...args, workspaces: ["amplifier", "dsx"] }),
      { code: "ACCESS_DENIED" },
    );
    assert.deepEqual(calls, []);
  }));
test("owner searches preserve workspace provenance for identical content", () =>
  fixture(async (s, g, t) => {
    s.setPrincipal("p", { allow: ["*"], deny: [] });
    const r: any = await g.execute(t, "query", args);
    assert.deepEqual(
      new Set(r.results.map((x: any) => x.workspace)),
      new Set(["amplifier", "dsx"]),
    );
    assert.notEqual(r.results[0].ref, r.results[1].ref);
  }));
test("foreign document references are denied before lookup", () =>
  fixture(async (_s, g, t, calls) => {
    await assert.rejects(
      g.execute(t, "get", {
        ref: encodeReference("dsx", "generation-1", "docs", "readme.md"),
      }),
      { code: "ACCESS_DENIED" },
    );
    assert.deepEqual(calls, []);
  }));
test("mixed multi-get authorizes every reference before reading any document", () =>
  fixture(async (_s, g, t, calls) => {
    await assert.rejects(
      g.execute(t, "multi_get", {
        refs: [
          encodeReference("amplifier", "generation-1", "docs", "readme.md"),
          encodeReference("dsx", "generation-1", "docs", "readme.md"),
        ],
      }),
      { code: "ACCESS_DENIED" },
    );
    assert.deepEqual(calls, []);
  }));
test("document handles are locators not credentials and reject traversal and short IDs", () => {
  for (const ref of [
    "#abc123",
    "../../dsx/index.sqlite",
    "qmd://dsx/readme.md",
    "qgdoc:invalid",
  ])
    assert.throws(() => parseReference(ref), { code: "INVALID_INPUT" });
  for (const path of [
    "../secret",
    "a/../../secret",
    "a\\secret",
    "/etc/passwd",
    "a%2fsecret",
    "a:3",
    "a//b",
  ])
    assert.throws(
      () => encodeReference("amplifier", "generation-1", "docs", path),
      { code: "INVALID_INPUT" },
    );
});
test("stale-generation references fail before reading data", () =>
  fixture(async (s, g, t, calls) => {
    s.publishGeneration("amplifier", "generation-2");
    await assert.rejects(
      g.execute(t, "get", {
        ref: encodeReference("amplifier", "generation-1", "docs", "readme.md"),
      }),
      { code: "NOT_FOUND" },
    );
    assert.deepEqual(calls, []);
  }));
test("status and workspace discovery reveal only authorized workspace names", () =>
  fixture(async (_s, g, t, calls) => {
    const listed: any = await g.execute(t, "list_workspaces", {});
    assert.deepEqual(
      listed.workspaces.map((w: any) => w.id),
      ["amplifier"],
    );
    const status: any = await g.execute(t, "status", {});
    assert.deepEqual(
      status.workspaces.map((w: any) => w.id),
      ["amplifier"],
    );
    assert.deepEqual(calls, ["amplifier"]);
  }));
test("revoking a token during a slow query prevents releasing its result", () =>
  fixture(async (s, g, t, calls, b) => {
    let finish!: (value: any) => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    b.search = async (w) => {
      calls.push(w.id);
      entered();
      return new Promise((r) => (finish = r));
    };
    const pending = g.execute(t, "query", args);
    await started;
    s.revokeToken(t);
    finish([]);
    await assert.rejects(pending, { code: "UNAUTHENTICATED" });
  }));
test("removing workspace grants during a query prevents releasing its result", () =>
  fixture(async (s, g, t, _calls, b) => {
    let finish!: (value: any) => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    b.search = async () => {
      entered();
      return new Promise((r) => (finish = r));
    };
    const pending = g.execute(t, "query", args);
    await started;
    s.setPrincipal("p", { allow: ["dsx"], deny: [] });
    finish([]);
    await assert.rejects(pending, { code: "ACCESS_DENIED" });
  }));
test("oversized document output and unreviewed methods are rejected", () =>
  fixture(async (_s, g, t, _calls, b) => {
    b.read = async () => ({
      collection: "docs",
      path: "readme.md",
      title: "Huge",
      body: "x".repeat(70000),
    });
    await assert.rejects(
      g.execute(t, "get", {
        ref: encodeReference("amplifier", "generation-1", "docs", "readme.md"),
      }),
      { code: "INVALID_INPUT" },
    );
    await assert.rejects(g.execute(t, "admin.issue_token", {}), {
      code: "INVALID_INPUT",
    });
  }));
test("invalid direct arguments cannot bypass transport validation", () =>
  fixture(async (_s, g, t, calls) => {
    await assert.rejects(g.execute(t, "query", { ...args, limit: 100000 }), {
      code: "INVALID_INPUT",
    });
    await assert.rejects(g.execute(t, "query", { ...args, workspaces: [] }), {
      code: "ACCESS_DENIED",
    });
    assert.deepEqual(calls, []);
  }));
test("long valid Unicode document paths round-trip through reference and get schemas", async () => {
  const path =
    Array.from({ length: 10 }, () => "é".repeat(90)).join("/") + ".md";
  const ref = encodeReference("amplifier", "generation-1", "docs", path);
  assert.equal(parseReference(ref).path, path);
  await fixture(async (_s, g, t, _calls, b) => {
    b.read = async () => ({
      collection: "docs",
      path,
      title: "Unicode",
      body: "Readable",
    });
    const result = await g.execute(t, "get", { ref });
    assert.equal(result.text, "Readable");
    const multi = await g.execute(t, "multi_get", { refs: [ref] });
    assert.equal((multi.documents as unknown[]).length, 1);
  });
});

test("multi_get pins one workspace snapshot across concurrent publication", async () => {
  for (const secondGeneration of ["g-new", "g-old"]) {
    let workspaceReads = 0;
    const contentReads: string[] = [];
    const state = {
      context: () => ({
        tokenId: "t",
        principalId: "p",
        allowed: ["docs"],
        revision: 1,
      }),
      workspace: () => ({
        id: "docs",
        generation: ++workspaceReads === 1 ? "g-old" : "g-new",
        sources: [],
      }),
    } as unknown as State;
    const gateway = new Gateway(state, {
      async search() {
        return [];
      },
      async status() {
        return { documents: 1, vectors: 0 };
      },
      async read(w, collection, path) {
        contentReads.push(w.generation!);
        return {
          collection,
          path,
          title: "Synthetic",
          body: "Must not be delivered",
        };
      },
    });
    let delivered = false;
    await assert.rejects(
      gateway
        .execute("t", "multi_get", {
          refs: [
            encodeReference("docs", "g-old", "guide", "README.md"),
            encodeReference("docs", secondGeneration, "guide", "README.md"),
          ],
        })
        .then((value) => {
          delivered = true;
          return value;
        }),
    );
    assert.equal(delivered, false);
    if (secondGeneration === "g-new") assert.deepEqual(contentReads, []);
    else assert.deepEqual(contentReads, ["g-old", "g-old"]);
  }
});

test("workspace listing accepts 50, preserves default 20 and paginates authorized names", () =>
  fixture(async (s, g, t) => {
    for (let i = 0; i < 55; i++)
      s.setWorkspace(`team-${String(i).padStart(2, "0")}`);
    s.setPrincipal("p", { allow: ["team-*"], deny: ["team-54"] });
    const first: any = await g.execute(t, "list_workspaces", {});
    assert.equal(first.workspaces.length, 20);
    assert.equal(first.nextOffset, 20);
    const large: any = await g.execute(t, "list_workspaces", { limit: 50 });
    assert.equal(large.workspaces.length, 50);
    assert.equal(large.nextOffset, 50);
    const last: any = await g.execute(t, "list_workspaces", {
      limit: 50,
      offset: large.nextOffset,
    });
    assert.equal(last.workspaces.length, 4);
    assert.equal(last.nextOffset, null);
    assert.deepEqual(
      [...large.workspaces, ...last.workspaces].map((w: any) => w.id),
      Array.from(
        { length: 54 },
        (_, i) => `team-${String(i).padStart(2, "0")}`,
      ),
    );
    for (const limit of [0, 51, 1.5])
      await assert.rejects(g.execute(t, "list_workspaces", { limit }), {
        code: "INVALID_INPUT",
      });
    await assert.rejects(
      g.execute(t, "query", {
        query: "test",
        workspaces: ["team-00"],
        limit: 21,
      }),
      { code: "INVALID_INPUT" },
    );
  }));
