import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
test("live qualification refuses without explicit opt-in", () => {
  const p = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/qualify-openai.ts"],
    { env: { ...process.env, GATE_LIVE_OPENAI: "" } },
  );
  let output = "";
  p.stderr.on("data", (d) => (output += d));
  return new Promise<void>((done, reject) =>
    p.on("exit", (code) => {
      try {
        assert.equal(code, 1);
        assert.match(output, /requires GATE_LIVE_OPENAI=1/);
        done();
      } catch (e) {
        reject(e);
      }
    }),
  );
});
async function exerciseDriver(
  t: { after(fn: () => void): void },
  options: { staleBody?: boolean; abnormalShutdown?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "gate-live-driver-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const initial = join(dir, "initial.json"),
    updated = join(dir, "updated.json"),
    ready = join(dir, "ready.json"),
    report = join(dir, "report.json"),
    preload = join(dir, "fake-provider.mjs"),
    cleanup = join(dir, "cleanup.json"),
    stateDir = join(dir, "state");
  const m = JSON.parse(
    readFileSync(
      new URL("./fixtures/wiki-rag-manifest.json", import.meta.url),
      "utf8",
    ),
  );
  writeFileSync(initial, JSON.stringify(m));
  writeFileSync(
    preload,
    `
    import { readFileSync, existsSync, writeFileSync } from 'node:fs';
    import { DatabaseSync } from 'node:sqlite';
    if (process.argv[1]?.endsWith('qualify-openai.ts')) {
      let closed = false;
      const close = DatabaseSync.prototype.close;
      DatabaseSync.prototype.close = function(...args) { const result=close.apply(this,args); closed=true; return result; };
      process.once('exit', () => writeFileSync(${JSON.stringify(cleanup)}, JSON.stringify({closed, handlers: ['SIGTERM','SIGINT'].some(s => process.listeners(s).some(f => f.name === 'interrupt'))})));
    }
    if (${Boolean(options.abnormalShutdown)} && process.argv.includes('serve')) process.on('SIGTERM', () => {process.exitCode=9;});
    const real=globalThis.fetch; let searches=0;
    globalThis.fetch=async(url,init)=>{
      if(!String(url).startsWith('https://api.openai.com/v1/'))return real(url,init);
      if(${Boolean(options.abnormalShutdown)})return new Response('{}',{status:403});
      const path=process.env.GATE_LIVE_UPDATED_MANIFEST;
      const m=JSON.parse(readFileSync(existsSync(path)?path:process.env.GATE_LIVE_MANIFEST,'utf8'));
      const c=Object.values(m.collections).find(c=>String(url).includes('/'+c.vector_store_id+'/'));
      if(!c)throw Error('unknown store');
      const changed=String(url).includes('/files/file-updated/');
      const value=changed&&!${Boolean(options.staleBody)}?'92':'47';
      return new Response(JSON.stringify(String(url).endsWith('/search')?{
        data:(++searches%3===0?Object.values(c.files):Object.values(c.files).reverse()).map(f=>({file_id:f.file_id,content:[{type:'text',text:'quartz synthetic'}],score:1})),has_more:false
      }:{data:[{type:'text',text:'quartz synthetic calibration '+value}],has_more:false}));
    };`,
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/qualify-openai.ts"],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: "--import=" + preload,
        GATE_LIVE_OPENAI: "1",
        GATE_LIVE_MANIFEST: initial,
        GATE_LIVE_UPDATED_MANIFEST: updated,
        GATE_LIVE_READY_FILE: ready,
        GATE_LIVE_REPORT: report,
        GATE_LIVE_STATE: stateDir,
        GATE_LIVE_PROJECT: "proj_test",
        GATE_LIVE_KEY_ENV: "SYNTHETIC_QUERY_KEY",
        SYNTHETIC_QUERY_KEY: "sk-proj-synthetic",
        GATE_LIVE_QUERY: "quartz",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
  let changed = false;
  const polling = setInterval(() => {
    if (!changed && existsSync(ready)) {
      changed = true;
      m.generation++;
      m.publication_id = "7d0c9d2a-e2ad-45ce-8ff1-c736ffdaf90a";
      m.collections.guide.files["README.md"].file_id = "file-updated";
      m.collections.guide.files["README.md"].sha256 = "b".repeat(64);
      writeFileSync(updated + ".tmp", JSON.stringify(m));
      renameSync(updated + ".tmp", updated);
    }
  }, 30);
  try {
    const code = await new Promise((r) => child.on("exit", r));
    const receipt = JSON.parse(readFileSync(report, "utf8"));
    const db = new DatabaseSync(join(stateDir, "gate.sqlite"));
    let active: number;
    try {
      active = Number(
        db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE revoked=0").get()!.n,
      );
    } finally {
      db.close();
    }
    return {
      code,
      output,
      changed,
      receipt,
      active,
      cleanup: JSON.parse(readFileSync(cleanup, "utf8")),
    };
  } finally {
    clearTimeout(timer);
    clearInterval(polling);
    child.kill("SIGTERM");
  }
}
test("live driver checks both current READMEs and changed body across real subprocess restart", async (t) => {
  const result = await exerciseDriver(t);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.changed, true);
  assert.equal(result.receipt.passed, true);
  for (const check of [
    "restart-persistence",
    "token-revocation",
    "current-readme-get",
    "changed-readme-body",
  ])
    assert.ok(result.receipt.checks.includes(check), check);
  assert.equal(result.active, 0);
  assert.deepEqual(result.cleanup, { closed: true, handlers: false });
  assert.ok(!JSON.stringify(result.receipt).includes("sk-proj-synthetic"));
  assert.ok(!JSON.stringify(result.receipt).includes("calibration"));
});
test("live driver refuses unchanged parsed body for a changed README publication", async (t) => {
  const result = await exerciseDriver(t, { staleBody: true });
  assert.equal(result.code, 1, result.output);
  assert.equal(result.receipt.passed, false);
  assert.equal(result.receipt.failedStage, "updated-import");
  assert.equal(result.active, 0);
  assert.deepEqual(result.cleanup, { closed: true, handlers: false });
});
test("abnormal child shutdown cannot skip token revocation, SQLite close or handler removal", async (t) => {
  const result = await exerciseDriver(t, { abnormalShutdown: true });
  assert.equal(result.code, 1);
  assert.equal(result.receipt.passed, false);
  assert.equal(result.active, 0);
  assert.deepEqual(result.cleanup, { closed: true, handlers: false });
});
