// Opt-in synthetic integration driver. The operator owns all cloud resources.
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { State } from "../src/state.js";
import type { Manifest } from "../src/manifest.js";
process.umask(0o077);
const checks: string[] = [];
let stage = "opt-in";
const root = fileURLToPath(new URL("..", import.meta.url));
const required = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error("Missing required configuration");
  return v;
};
function atomic(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path + ".tmp", JSON.stringify(value) + "\n", { mode: 0o600 });
  renameSync(path + ".tmp", path);
}
async function main() {
  if (process.env.GATE_LIVE_OPENAI !== "1")
    throw new Error("Live qualification requires GATE_LIVE_OPENAI=1");
  stage = "configuration";
  const initial = required("GATE_LIVE_MANIFEST"),
    updated = required("GATE_LIVE_UPDATED_MANIFEST"),
    ready = required("GATE_LIVE_READY_FILE"),
    stateDir = required("GATE_LIVE_STATE"),
    project = required("GATE_LIVE_PROJECT"),
    keyEnv = required("GATE_LIVE_KEY_ENV"),
    query = required("GATE_LIVE_QUERY");
  required("GATE_LIVE_REPORT");
  required(keyEnv);
  assert.equal(existsSync(updated), false);
  assert.equal(existsSync(ready), false);
  assert.equal(existsSync(join(stateDir, "gate.sqlite")), false);
  const manifest = JSON.parse(readFileSync(initial, "utf8")) as Manifest;
  const count = (m: Manifest) =>
    Object.values(m.collections).reduce(
      (n, c) => n + Object.keys(c.files).length,
      0,
    );
  const importManifest = (path: string, id = "synthetic") => {
    const args = [
      "--import",
      "tsx",
      "src/cli.ts",
      "import-openai",
      "--state",
      stateDir,
      "--id",
      id,
      "--manifest",
      path,
      "--project",
      project,
      "--credential-env",
      keyEnv,
    ];
    for (const [name, c] of Object.entries(manifest.collections))
      args.push("--store", name + "=" + c.vector_store_id);
    execFileSync(process.execPath, args, {
      cwd: root,
      stdio: "pipe",
      timeout: 30000,
    });
  };
  stage = "initial-import";
  importManifest(initial);
  importManifest(initial, "forbidden");
  const state = new State(stateDir);
  state.setPrincipal("synthetic-reader", { allow: ["synthetic"], deny: [] });
  const token = state.issueToken(
    "synthetic-reader",
    "synthetic-qualification",
    Date.now() + 3600000,
  );
  let child: ChildProcess | undefined,
    exit: Promise<number | null> | undefined,
    client: Client | undefined;
  const stopping = new AbortController();
  const interrupt = () => {
    stopping.abort();
    child?.kill("SIGTERM");
  };
  process.on("SIGTERM", interrupt);
  process.on("SIGINT", interrupt);
  async function stop() {
    try {
      await client?.close();
    } finally {
      client = undefined;
      if (child) {
        child.kill("SIGTERM");
        const timer = setTimeout(() => child?.kill("SIGKILL"), 10000);
        try {
          assert.equal(await exit, 0);
        } finally {
          clearTimeout(timer);
          child = undefined;
        }
      }
    }
  }
  async function start() {
    child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "serve",
        "--state",
        stateDir,
        "--port",
        "0",
      ],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    exit = new Promise((r) => child!.once("exit", r));
    child.stderr!.resume();
    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(
        () => reject(new Error("Server startup deadline")),
        30000,
      );
      child!.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Server exited"));
      });
      child!.stdout!.on("data", (data) => {
        out = (out + String(data)).slice(-4096);
        const match = /MCP listening at (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(
          out,
        );
        if (match) {
          clearTimeout(timer);
          resolve(match[1]!);
        }
      });
    });
    client = new Client({
      name: "synthetic-openai-qualification",
      version: "1",
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: "Bearer " + token.secret } },
      }),
    );
  }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client!.callTool({ name, arguments: args });
    assert.notEqual(r.isError, true);
    assert.equal(r.structuredContent, undefined);
    const content = r.content as { type: string; text: string }[];
    assert.equal(content[0]?.type, "text");
    return JSON.parse(content[0]!.text);
  };
  const queryReady = async () => {
    const end = Date.now() + 240000;
    do {
      stopping.signal.throwIfAborted();
      const r = await call("query", { query, mode: "hybrid", limit: 20 });
      const readmes = r.results.filter(
        (r: any) => r.path.split("/").at(-1) === "README.md",
      );
      if (new Set(readmes.map((r: any) => r.source.repository)).size >= 2)
        return r;
      await delay(1500, undefined, { signal: stopping.signal });
    } while (Date.now() < end);
    throw new Error("Search visibility deadline");
  };
  try {
    stage = "initial-mcp";
    await start();
    assert.equal((await client!.listTools()).tools.length, 6);
    checks.push("mcp-initialize-tools");
    const first = await queryReady();
    const refs = first.results.map((r: any) => r.ref) as string[];
    checks.push("two-repository-readmes");
    for (const mode of ["lex", "vec", "hybrid"]) {
      const r = await call("query", { query, mode, limit: 20 });
      assert.ok(r.results.length > 0);
    }
    checks.push("retrieval-weight-modes");
    const initialBodies = new Map<string, string>();
    for (const ref of refs) {
      const d = await call("get", { ref, maxLines: 200 });
      assert.ok(
        d.totalLines <= 200,
        "Synthetic qualification documents must fit in 200 parsed lines",
      );
      initialBodies.set(d.source.repository + "\0" + d.path, d.text);
      assert.equal(d.source.kind, "openai");
      assert.equal(d.source.lineBasis, "parsed-text");
      assert.ok(d.text.length > 0);
    }
    checks.push("parsed-get-provenance");
    const status = await call("status");
    assert.equal(status.workspaces[0].vectors, null);
    assert.equal(status.workspaces[0].documents, count(manifest));
    checks.push("unknown-vectors-active-count");
    const denied = await client!.callTool({
      name: "query",
      arguments: { query, workspaces: ["forbidden"] },
    });
    assert.equal(denied.isError, true);
    checks.push("forbidden-workspace");
    const priorGeneration = state.workspace("synthetic").generation;
    importManifest(initial);
    assert.equal(state.workspace("synthetic").generation, priorGeneration);
    for (const ref of refs) await call("get", { ref });
    checks.push("noop-reference-stability");
    atomic(ready, { phase: "initial-complete", checks });
    stage = "await-update";
    const end = Date.now() + 240000;
    while (!existsSync(updated)) {
      stopping.signal.throwIfAborted();
      if (Date.now() > end) throw new Error("Update deadline");
      await delay(250, undefined, { signal: stopping.signal });
    }
    stage = "updated-import";
    const next = JSON.parse(readFileSync(updated, "utf8")) as Manifest;
    importManifest(updated);
    assert.notEqual(next.publication_id, manifest.publication_id);
    for (const ref of refs) {
      const stale = await client!.callTool({ name: "get", arguments: { ref } });
      assert.equal(stale.isError, true);
    }
    checks.push("stale-reference-rejection");
    const fresh = await queryReady();
    const freshRef = fresh.results[0].ref;
    assert.notEqual(freshRef, refs[0]);
    let readmeCount = 0,
      changedReadmeCount = 0;
    for (const [collection, c] of Object.entries(next.collections)) {
      for (const [path, file] of Object.entries(c.files)) {
        if (path.split("/").at(-1) !== "README.md") continue;
        const hit = fresh.results.find(
          (r: any) =>
            r.collection === collection &&
            r.path === path &&
            r.source.repository === c.repository,
        );
        assert.ok(
          hit,
          "Each current README must be returned by the synthetic query",
        );
        const d = await call("get", { ref: hit.ref, maxLines: 200 });
        assert.ok(
          d.totalLines <= 200,
          "Synthetic qualification documents must fit in 200 parsed lines",
        );
        assert.equal(d.source.publicationId, next.publication_id);
        assert.equal(d.source.sha256, file.sha256);
        assert.equal(d.source.repository, c.repository);
        assert.equal(d.path, path);
        readmeCount++;
        const oldCollection = manifest.collections[collection];
        const oldFile = oldCollection?.files[path];
        if (
          oldCollection?.repository === c.repository &&
          oldFile &&
          oldFile.sha256 !== file.sha256
        ) {
          const before = initialBodies.get(c.repository + "\0" + path);
          assert.ok(
            before !== undefined,
            "Changed README needs an initial body",
          );
          assert.notEqual(
            d.text,
            before,
            "Changed README parsed body must change",
          );
          changedReadmeCount++;
        }
      }
    }
    assert.ok(readmeCount >= 2);
    assert.ok(
      changedReadmeCount >= 1,
      "Qualification requires at least one content-changed README",
    );
    checks.push("current-readme-get", "changed-readme-body");
    assert.equal((await call("status")).workspaces[0].documents, count(next));
    checks.push("updated-query-get");
    stage = "restart";
    await stop();
    await start();
    const restarted = await call("get", { ref: freshRef });
    assert.equal(restarted.source.publicationId, next.publication_id);
    checks.push("restart-persistence");
    stage = "revoke";
    state.revokeToken(token.id);
    await assert.rejects(client!.listTools());
    checks.push("token-revocation");
  } finally {
    try {
      await stop();
    } finally {
      try {
        state.revokeToken(token.id);
      } finally {
        try {
          state.close();
        } finally {
          process.removeListener("SIGTERM", interrupt);
          process.removeListener("SIGINT", interrupt);
        }
      }
    }
  }
  atomic(required("GATE_LIVE_REPORT"), { passed: true, checks });
  console.log(
    "Synthetic OpenAI qualification passed (" + checks.length + " checks).",
  );
}
main().catch(() => {
  if (process.env.GATE_LIVE_REPORT)
    atomic(process.env.GATE_LIVE_REPORT, {
      passed: false,
      failedStage: stage,
      checks,
    });
  console.error(
    stage === "opt-in"
      ? "Live qualification requires GATE_LIVE_OPENAI=1"
      : "Synthetic OpenAI qualification failed at " +
          stage +
          "; no provider details recorded.",
  );
  process.exitCode = 1;
});
