import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { State } from "../src/state.js";
test("operator CLI registers, indexes, issues and revokes without printing secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-cli-")),
    state = join(dir, "state"),
    docs = join(dir, "docs"),
    token = join(dir, "credential.json");
  mkdirSync(docs);
  writeFileSync(join(docs, "hello.md"), "# Hello\nquartz");
  const run = (...args: string[]) =>
    execFileSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args, "--state", state],
      { encoding: "utf8" },
    );
  try {
    run("workspace", "--id", "amplifier", "--source", `docs=${docs}`);
    run("principal", "--id", "owner", "--allow", "*");
    run("index", "--id", "amplifier");
    const output = run(
      "token",
      "--principal",
      "owner",
      "--name",
      "local",
      "--out",
      token,
    );
    const issued = JSON.parse(readFileSync(token, "utf8"));
    assert.ok(!output.includes(issued.secret));
    assert.equal(statSync(token).mode & 0o777, 0o600);
    const s = new State(state);
    try {
      assert.ok(s.workspace("amplifier").generation);
      s.authenticate(`Bearer ${issued.secret}`);
      run("revoke", "--id", issued.id);
      assert.throws(() => s.authenticate(`Bearer ${issued.secret}`));
    } finally {
      s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
