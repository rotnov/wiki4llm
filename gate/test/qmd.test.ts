import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state.js";
import { QmdBackend } from "../src/qmd.js";
test("real QMD indexes separate stores, reads exact paths, persists, and shares one runtime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-qmd-"));
  const s = new State(join(dir, "state"));
  let b: QmdBackend | undefined;
  try {
    for (const id of ["amplifier", "dsx"]) {
      const root = join(dir, id);
      mkdirSync(root);
      writeFileSync(
        join(root, "hello.md"),
        `# ${id}\nquartz ${id} exclusive\n`,
      );
      s.setWorkspace(id, [{ name: "docs", path: root }]);
    }
    b = await QmdBackend.open(s.dir);
    for (const w of s.workspaces())
      s.publishGeneration(w.id, await b.index(w, false));
    const signal = new AbortController().signal;
    const a = await b.search(
      s.workspace("amplifier"),
      "quartz",
      "lex",
      10,
      signal,
    );
    assert.equal(a.length, 1);
    assert.match(a[0]!.body, /amplifier/);
    assert.doesNotMatch(a[0]!.body, /dsx/);
    assert.equal(
      (await b.search(s.workspace("dsx"), "quartz", "lex", 10, signal)).length,
      1,
    );
    assert.equal(b.runtimeCount, 1);
    assert.equal(
      (await b.read(s.workspace("dsx"), "docs", "hello.md", signal))!.title,
      "dsx",
    );
    assert.equal(
      await b.read(s.workspace("dsx"), "docs", "hello", signal),
      undefined,
    );
    await b.close();
    b = await QmdBackend.open(s.dir);
    assert.equal((await b.status(s.workspace("dsx"), signal)).documents, 1);
  } finally {
    await b?.close();
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("unsafe source never publishes a replacement generation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-qmd-"));
  const s = new State(join(dir, "state"));
  const root = join(dir, "docs");
  mkdirSync(root);
  writeFileSync(join(root, "ok.md"), "# Good\nquartz");
  s.setWorkspace("demo", [{ name: "docs", path: root }]);
  const b = await QmdBackend.open(s.dir);
  try {
    const gen = await b.index(s.workspace("demo"), false);
    s.publishGeneration("demo", gen);
    symlinkSync("/etc/passwd", join(root, "bad.md"));
    await assert.rejects(b.index(s.workspace("demo"), false));
    assert.equal(s.workspace("demo").generation, gen);
  } finally {
    await b.close();
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("official HTTP client retrieves real indexed data and denies foreign references", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { startServer } = await import("../src/http.js");
  const { Gateway, encodeReference } = await import("../src/gateway.js");
  const dir = mkdtempSync(join(tmpdir(), "gate-e2e-")),
    s = new State(join(dir, "state"));
  const b = await QmdBackend.open(s.dir);
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  const client = new Client({ name: "e2e", version: "1" });
  try {
    for (const id of ["amplifier", "dsx"]) {
      const root = join(dir, id);
      mkdirSync(root);
      writeFileSync(join(root, "hello.md"), `# ${id}\nquartz ${id}`);
      s.setWorkspace(id, [{ name: "docs", path: root }]);
      s.publishGeneration(id, await b.index(s.workspace(id), false));
    }
    s.setPrincipal("reader", { allow: ["amplifier"], deny: [] });
    const t = s.issueToken("reader", "e2e", Date.now() + 60000);
    server = await startServer(s, new Gateway(s, b), 0);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${t.secret}` } },
      }),
    );
    const result: any = await client.callTool({
      name: "query",
      arguments: { query: "quartz", mode: "lex" },
    });
    assert.equal(result.structuredContent.results.length, 1);
    const ref = result.structuredContent.results[0].ref;
    const doc: any = await client.callTool({ name: "get", arguments: { ref } });
    assert.match(doc.structuredContent.text, /amplifier/);
    const denied: any = await client.callTool({
      name: "get",
      arguments: {
        ref: encodeReference(
          "dsx",
          s.workspace("dsx").generation!,
          "docs",
          "hello.md",
        ),
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(denied.content[0].text, "ACCESS_DENIED");
  } finally {
    await client.close();
    await server?.close();
    await b.close();
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
