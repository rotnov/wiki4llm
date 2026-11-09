import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BoundedQueue } from "../src/queue.js";
import { acquireLease } from "../src/lease.js";
const tick = () => new Promise<void>((r) => setImmediate(r));
test("only one expensive job executes and pending admission is bounded", async () => {
  const q = new BoundedQueue(1, 1000);
  let release!: (x: number) => void;
  const first = q.run(async () => new Promise<number>((r) => (release = r)));
  await tick();
  const second = q.run(async () => 2);
  await assert.rejects(
    q.run(async () => 3),
    { code: "BUSY" },
  );
  release(1);
  assert.equal(await first, 1);
  assert.equal(await second, 2);
});
test("cancelled queued work never starts", async () => {
  const q = new BoundedQueue(2, 1000);
  let release!: () => void;
  const first = q.run(async () => new Promise<void>((r) => (release = r)));
  await tick();
  const abort = new AbortController();
  let called = false;
  const second = q.run(async () => {
    called = true;
  }, abort.signal);
  abort.abort();
  await assert.rejects(second, { code: "CANCELLED" });
  release();
  await first;
  assert.equal(called, false);
});
test("an active deadline does not free its slot before underlying work settles", async () => {
  const q = new BoundedQueue(2, 25);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  const first = q.run(async () => {
    entered();
    return new Promise<void>((r) => (release = r));
  });
  const expired = assert.rejects(first, { code: "CANCELLED" });
  await started;
  await expired;
  let secondStarted = false;
  const second = q.run(async () => {
    secondStarted = true;
  });
  await tick();
  assert.equal(secondStarted, false);
  release();
  await second;
});
test("state directory lease prevents overlapping serving and indexing", () => {
  const dir = mkdtempSync(join(tmpdir(), "qmd-lease-"));
  try {
    const release = acquireLease(dir);
    assert.throws(() => acquireLease(dir), { code: "CONFLICT" });
    release();
    acquireLease(dir)();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
