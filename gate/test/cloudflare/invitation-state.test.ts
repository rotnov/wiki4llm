import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { DurableObjectStorage } from "@cloudflare/workers-types/index.js";
import { Invitations } from "../../src/cloudflare/invitations.js";
import { CloudState } from "../../src/cloudflare/state.js";

function storageFixture() {
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
  return { db, storage };
}

test("invitation expiry, issuer isolation and transaction rollback preserve pending state", () => {
  const { db, storage } = storageFixture();
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
      invitations.accept(token, {
        ...identity,
        issuer: "https://other.cloudflareaccess.com",
      }),
    );
    now += 60000;
    assert.equal(invitations.status({ id: created.id }).status, "expired");
    assert.throws(() => invitations.accept(token, identity));
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
      invitations.accept(next.url.split("/").at(-1)!, identity),
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
      invitations.accept(full.url.split("/").at(-1)!, identity),
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

test("prefix invitations preserve namespace grants for workspaces published after acceptance", () => {
  const { db, storage } = storageFixture();
  const issuer = "https://example.cloudflareaccess.com";
  const state = new CloudState(storage, issuer, "aud");
  const invitations = new Invitations(storage, state);
  const identity = {
    issuer,
    key: "user:future",
    email: "future@example.org",
    expiresAt: Date.now() + 86400000,
  };
  try {
    for (const pattern of [
      "*",
      "amplifier*",
      "amplifier-**",
      "amplifier-*/nested",
      "missing-exact",
    ])
      assert.throws(() =>
        invitations.create(
          { email: identity.email, workspaces: [pattern] },
          issuer,
          "https://gate.example",
          identity,
        ),
      );
    state.setPrincipal(
      "restricted",
      { allow: [], deny: ["amplifier-blocked"] },
      true,
    );
    state.bind(identity.key, "restricted", true);
    const invitation = invitations.create(
      { email: identity.email, workspaces: ["amplifier-*"] },
      issuer,
      "https://gate.example",
      identity,
    );
    assert.deepEqual(invitations.status({ id: invitation.id }).workspaces, [
      "amplifier-*",
    ]);
    assert.match(invitation.prompt, /amplifier-\*/);
    const accepted = invitations.accept(
      invitation.url.split("/").at(-1)!,
      identity,
    );
    assert.deepEqual(accepted.workspaces, []);
    for (const id of [
      "amplifier-meddylib",
      "amplifier-new-project",
      "amplifier-blocked",
      "amplifier",
      "amplifierx-other",
      "demo",
    ])
      db.prepare("INSERT INTO workspaces VALUES(?,'g','[]',1,1,'d')").run(id);
    assert.deepEqual(state.context(identity).allowed, [
      "amplifier-meddylib",
      "amplifier-new-project",
    ]);
    const grants = JSON.parse(
      String(
        db
          .prepare("SELECT grants_json FROM principals WHERE id=?")
          .get("invite-" + invitation.id)!.grants_json,
      ),
    );
    assert.deepEqual(grants, {
      allow: ["amplifier-*"],
      deny: ["amplifier-blocked"],
    });
    assert.deepEqual(
      invitations.recipientAccess(invitation.url.split("/").at(-1)!, identity)!
        .workspaces,
      ["amplifier-meddylib", "amplifier-new-project"],
    );
  } finally {
    db.close();
  }
});
