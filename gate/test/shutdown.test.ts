import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("SIGTERM releases the lease when native dependencies register signal-exit after startup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-shutdown-"));
  // Native inference loads proper-lockfile/signal-exit lazily after our server starts.
  const preload = `import {createRequire} from 'node:module';
 const require=createRequire(process.cwd()+'/package.json');
 const write=process.stdout.write.bind(process.stdout);
 process.stdout.write=(chunk,...args)=>{const result=write(chunk,...args);if(String(chunk).includes('MCP listening'))setImmediate(()=>{require('signal-exit')(()=>{});write('SHUTDOWN_PROBE_READY\\n')});return result};`;
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "data:text/javascript," + encodeURIComponent(preload),
      "src/cli.ts",
      "serve",
      "--port",
      "0",
      "--state",
      dir,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  let output = "";
  let signalled = false;
  child.stderr.resume();
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
    if (!signalled && output.includes("SHUTDOWN_PROBE_READY")) {
      signalled = true;
      child.kill("SIGTERM");
    }
  });
  try {
    const result = await exited;
    assert.ok(output.includes("SHUTDOWN_PROBE_READY"));
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(existsSync(join(dir, ".process-lock")), false);
  } finally {
    clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
  }
});
