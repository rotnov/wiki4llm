import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const listener = createServer();
await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
const address = listener.address();
if (!address || typeof address === "string") throw new Error("No port");
const port = address.port;
await new Promise<void>((r) => listener.close(() => r()));
mkdirSync(".data", { recursive: true });
const root = mkdtempSync(resolve(".data/compose-smoke-")),
  data = join(root, "data"),
  sources = join(root, "sources");
mkdirSync(data);
mkdirSync(sources);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  WIKI_RAG_GATE_DATA_DIR: data,
  WIKI_RAG_GATE_SOURCE_DIR: sources,
  WIKI_RAG_GATE_PORT: String(port),
  WIKI_RAG_GATE_UID: String(process.getuid?.() ?? 1000),
  WIKI_RAG_GATE_GID: String(process.getgid?.() ?? 1000),
};
delete env.WIKI_RAG_GATE_AUTHORITY;
const project = `wiki-rag-gate-smoke-${process.pid}`;
async function compose(...args: string[]) {
  const result = await execute(
    "docker",
    ["compose", "-f", "compose.yaml", "-p", project, ...args],
    { env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  return result.stdout;
}
function cli(...args: string[]) {
  return compose(
    "run",
    "--rm",
    "--no-deps",
    "wiki-rag-gate",
    ...args,
    "--state",
    "/data",
  );
}
let started = false;
try {
  await compose("config", "--quiet");
  started = true;
  const native = await compose(
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "wiki-rag-gate",
    "-e",
    'import("node-llama-cpp").then(async ({getLlama})=>{const llama=await getLlama({gpu:false,build:"never"}); console.log(JSON.stringify({gpu:llama.gpu})); await llama.dispose();})',
  );
  assert.equal(JSON.parse(native).gpu, false);
  console.log(
    "PASS: packaged CPU inference runtime loads with read-only root filesystem",
  );
  for (const id of ["amplifier", "dsx"]) {
    mkdirSync(join(sources, id));
    writeFileSync(
      join(sources, id, "readme.md"),
      `# ${id}\nquartz ${id} synthetic\n`,
    );
    await cli("workspace", "--id", id, "--source", `docs=/sources/${id}`);
  }
  await cli("principal", "--id", "reader", "--allow", "amplifier");
  await cli("index");
  await cli(
    "token",
    "--principal",
    "reader",
    "--name",
    "smoke",
    "--out",
    "/data/smoke-token.json",
  );
  const credential = JSON.parse(
    readFileSync(join(data, "smoke-token.json"), "utf8"),
  );
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  let previousRef: string | undefined;
  async function verify() {
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    const client = new Client({ name: "compose-smoke", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: {
            headers: { Authorization: `Bearer ${credential.secret}` },
          },
        }),
      );
      const found: any = await client.callTool({
        name: "query",
        arguments: { query: "quartz", mode: "lex" },
      });
      assert.equal(found.isError, undefined);
      assert.equal(found.structuredContent, undefined);
      assert.equal(found.content[0]?.type, "text");
      const payload = JSON.parse(found.content[0].text);
      assert.equal(payload.results.length, 1);
      const hit = payload.results[0];
      assert.equal(hit.workspace, "amplifier");
      if (previousRef) assert.equal(hit.ref, previousRef);
      previousRef = hit.ref;
      const read: any = await client.callTool({
        name: "get",
        arguments: { ref: hit.ref },
      });
      assert.equal(read.isError, undefined);
      assert.equal(read.structuredContent, undefined);
      assert.equal(read.content[0]?.type, "text");
      assert.match(JSON.parse(read.content[0].text).text, /amplifier/);
      const denied: any = await client.callTool({
        name: "status",
        arguments: { workspaces: ["dsx"] },
      });
      assert.equal(denied.isError, true);
      assert.equal(denied.content[0].text, "ACCESS_DENIED");
    } finally {
      await client.close();
    }
  }
  await compose("up", "-d", "--wait", "--wait-timeout", "90");
  await verify();
  console.log("PASS: initial authenticated retrieval and isolation");
  await assert.rejects(() => cli("index", "--id", "amplifier"), /CONFLICT/);
  await compose(
    "up",
    "-d",
    "--force-recreate",
    "--wait",
    "--wait-timeout",
    "90",
  );
  await verify();
  console.log(
    "PASS: same token and document reference after container recreation",
  );
  await cli("revoke", "--id", credential.id);
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.secret}` },
      })
    ).status,
    401,
  );
  console.log(
    "PASS: real QMD MCP query/get, workspace isolation, serve/index lease, recreation persistence, and live token revocation.",
  );
} finally {
  if (started) await compose("down", "--remove-orphans");
  rmSync(root, { recursive: true, force: true });
}
