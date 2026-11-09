import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State } from "../src/state.js";
function fixture(
  fn: (state: State, dir: string, setNow: (n: number) => void) => void,
) {
  const dir = mkdtempSync(join(tmpdir(), "qmd-gate-"));
  let now = 1000;
  let s: State | undefined;
  try {
    s = new State(dir, () => now);
    fn(s, dir, (n) => (now = n));
  } finally {
    s?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
test("tokens are random opaque credentials and only hashes persist", () =>
  fixture((s, dir) => {
    s.setPrincipal("owner", { allow: ["*"], deny: [] });
    const a = s.issueToken("owner", "one", 5000);
    const b = s.issueToken("owner", "two", 5000);
    assert.match(a.secret, /^qg_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a.secret, b.secret);
    assert.equal(s.authenticate("Bearer " + a.secret).principalId, "owner");
    s.close();
    assert.ok(
      !readFileSync(join(dir, "gate.sqlite")).includes(Buffer.from(a.secret)),
    );
  }));
test("unknown, malformed and expired tokens are rejected", () =>
  fixture((s, _d, setNow) => {
    s.setPrincipal("p", { allow: ["dsx"], deny: [] });
    const t = s.issueToken("p", "test", 2000);
    for (const h of [
      undefined,
      "",
      t.secret,
      "Bearer " + t.secret + "x",
      "Bearer qg_" + "x".repeat(43),
    ])
      assert.throws(() => s.authenticate(h), { code: "UNAUTHENTICATED" });
    setNow(2000);
    assert.throws(() => s.authenticate("Bearer " + t.secret), {
      code: "UNAUTHENTICATED",
    });
  }));
test("revocation invalidates an already authenticated token context", () =>
  fixture((s) => {
    s.setPrincipal("p", { allow: ["*"], deny: [] });
    const t = s.issueToken("p", "test", 5000);
    const c = s.authenticate("Bearer " + t.secret);
    s.revokeToken(t.id);
    assert.throws(() => s.context(c.tokenId), { code: "UNAUTHENTICATED" });
  }));
test("principal changes and token constraints affect current effective grants", () =>
  fixture((s) => {
    s.setWorkspace("amplifier");
    s.setWorkspace("dsx");
    s.setPrincipal("p", { allow: ["*"], deny: [] });
    const t = s.issueToken("p", "test", 5000, { allow: ["dsx"], deny: [] });
    assert.deepEqual(s.context(t.id).allowed, ["dsx"]);
    s.setPrincipal("p", { allow: ["amplifier"], deny: [] });
    assert.deepEqual(s.context(t.id).allowed, []);
    s.setPrincipal("p", { allow: ["*"], deny: [] }, false);
    assert.throws(() => s.context(t.id), { code: "UNAUTHENTICATED" });
  }));
test("credentials, grants and workspace generations survive reopening", () =>
  fixture((s, dir) => {
    s.setWorkspace("dsx");
    s.publishGeneration("dsx", "generation-1");
    s.setPrincipal("p", { allow: ["dsx"], deny: [] });
    const t = s.issueToken("p", "test", 5000);
    s.close();
    const reopened = new State(dir, () => 1000);
    try {
      assert.deepEqual(reopened.authenticate("Bearer " + t.secret).allowed, [
        "dsx",
      ]);
      assert.equal(reopened.workspace("dsx").generation, "generation-1");
    } finally {
      reopened.close();
    }
  }));
test("invalid policy edits do not destroy previous valid grants", () =>
  fixture((s) => {
    s.setPrincipal("p", { allow: ["dsx"], deny: [] });
    s.setWorkspace("dsx");
    const t = s.issueToken("p", "test", 5000);
    assert.throws(() => s.setPrincipal("p", { allow: ["dsx*"], deny: [] }), {
      code: "INVALID_INPUT",
    });
    assert.deepEqual(s.context(t.id).allowed, ["dsx"]);
  }));
test("data owner tokens carry no administrative capability", () =>
  fixture((s) => {
    s.setPrincipal("p", { allow: ["*"], deny: [] });
    const t = s.issueToken("p", "test", 5000);
    assert.equal("admin" in s.context(t.id), false);
  }));
