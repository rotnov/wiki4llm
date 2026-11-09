import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const { repairDeclarations } =
  await import("../../scripts/repair-miniflare-types.js").catch(() => ({
    repairDeclarations: undefined,
  }));
test("Miniflare declaration repair is exact-version/hash guarded and idempotent", () => {
  assert.ok(repairDeclarations, "typed declaration repair implemented");
  const source = readFileSync(
    "node_modules/miniflare/dist/src/index.d.ts",
    "utf8",
  );
  const repaired = repairDeclarations(source, "4.20260730.0");
  assert.equal(repairDeclarations(repaired, "4.20260730.0"), repaired);
  assert.throws(() => repairDeclarations(source + "\n", "4.20260730.0"));
  assert.throws(() => repairDeclarations(source, "4.20260730.1"));
  assert.ok(repaired.includes("from 'zod/v3'"));
});
test("declaration install hook only permits absent tooling for an explicit production install", async () => {
  const module = await import("../../scripts/repair-miniflare-types.js");
  assert.ok(
    "repairInstalled" in module,
    "install hook supports omitted dev dependencies",
  );
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const root = mkdtempSync(join(tmpdir(), "gate-tooling-"));
  try {
    const repair = (
      module as typeof module & {
        repairInstalled: (root: URL, omitDev: boolean) => boolean;
      }
    ).repairInstalled;
    assert.equal(repair(pathToFileURL(root + "/"), true), false);
    assert.throws(() => repair(pathToFileURL(root + "/"), false));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("production packaging invokes the hook with Node alone and fails closed for a broken dev install", async () => {
  const { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "gate-install-"));
  try {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    copyFileSync(
      "scripts/repair-miniflare-types.ts",
      join(root, "scripts/repair-miniflare-types.ts"),
    );
    const production = spawnSync(
      process.execPath,
      ["scripts/repair-miniflare-types.ts"],
      {
        cwd: root,
        env: { NODE_ENV: "production", npm_config_omit: "dev" },
        encoding: "utf8",
      },
    );
    assert.equal(production.status, 0, production.stderr);
    assert.match(production.stdout, /omits development-only Miniflare/);
    assert.equal(production.stderr, "");
    const development = spawnSync(
      process.execPath,
      ["scripts/repair-miniflare-types.ts"],
      { cwd: root, env: {}, encoding: "utf8" },
    );
    assert.notEqual(development.status, 0);
    assert.match(
      development.stderr,
      /Required development dependency Miniflare is missing/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
