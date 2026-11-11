import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { DurableObjectStorage } from "@cloudflare/workers-types/index.js";
import { Invitations } from "../../src/cloudflare/invitations.js";
import { CloudState } from "../../src/cloudflare/state.js";

test("invitation expiry, issuer isolation and transaction rollback preserve pending state", () => {
  const db = new DatabaseSync(":memory:");
  const storage = {
    sql: {
      exec(query: string, ...args: (string | number)[]) {
        if (!args.length && !/^SELECT/i.test(query.trim())) {
          db.exec(query);
          return { toArray: () => [] };
        }
        const statement = db.prepare(query);
        const rows = /^SELECT/i.test(query.trim())
          ? statement.all(...args)
          : (statement.run(...args), []);
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(fn: () => T): T {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as DurableObjectStorage;
  const issuer = "https://example.cloudflareaccess.com";
  const state = new CloudState(storage, issuer, "aud");
  db.exec("INSERT INTO workspaces VALUES('example','g','[]',1,1,'d')");
  let now = Date.now();
  const invitations = new Invitations(storage, state, () => now);
  const identity = {
    issuer,
    key: "user:reader",
    email: "reader@example.org",
    expiresAt: now + 86400000,
  };
  try {
    const created = invitations.create(
      {
        email: "reader@example.org",
        workspaces: ["example"],
        expiresInSeconds: 60,
      },
      issuer,
      "https://gate.example",
      identity,
    );
    const token = created.url.split("/").at(-1)!;
    const row = db.prepare("SELECT * FROM invitations").get()!;
    assert.notEqual(row.token_hash, token);
    assert.equal(JSON.stringify(row).includes(token), false);
    assert.throws(() =>
      invitations.accept(
        token,
        { ...identity, issuer: "https://other.cloudflareaccess.com" },
        "https://gate.example/mcp",
      ),
    );
    now += 60000;
    assert.equal(invitations.status({ id: created.id }).status, "expired");
    assert.throws(() =>
      invitations.accept(token, identity, "https://gate.example/mcp"),
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM identities").get()!.n,
      0,
    );
    const next = invitations.create(
      { email: "reader@example.org", workspaces: ["example"] },
      issuer,
      "https://gate.example",
      identity,
    );
    state.setPrincipal("disabled", { allow: ["example"], deny: [] }, false);
    state.bind(identity.key, "disabled", true);
    assert.throws(() =>
      invitations.accept(
        next.url.split("/").at(-1)!,
        identity,
        "https://gate.example/mcp",
      ),
    );
    assert.equal(invitations.status({ id: next.id }).status, "pending");
    assert.equal(
      db.prepare("SELECT principal FROM identities").get()!.principal,
      "disabled",
    );
    const unusual = invitations.create(
      { email: "a/b@example.org", workspaces: ["example"] },
      issuer,
      "https://gate.example",
      identity,
    );
    assert.equal(
      invitations.status({ id: unusual.id }).email,
      "a/b@example.org",
    );
    state.setPrincipal(
      "full",
      {
        allow: Array.from({ length: 100 }, (_, i) => "workspace-" + i),
        deny: [],
      },
      true,
    );
    state.bind(identity.key, "full", true);
    const full = invitations.create(
      { email: identity.email, workspaces: ["example"] },
      issuer,
      "https://gate.example",
      identity,
    );
    assert.throws(() =>
      invitations.accept(
        full.url.split("/").at(-1)!,
        identity,
        "https://gate.example/mcp",
      ),
    );
    assert.equal(invitations.status({ id: full.id }).status, "pending");
    assert.equal(
      db.prepare("SELECT principal FROM identities").get()!.principal,
      "full",
    );
  } finally {
    db.close();
  }
});
