import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const result = await build({
  entryPoints: ["src/cloudflare/worker.ts"],
  bundle: true,
  write: false,
  metafile: true,
  format: "esm",
  platform: "browser",
  external: ["node:*", "cloudflare:workers"],
  target: "es2023",
});
const forbidden =
  /(?:node:(?:fs|sqlite|http|https|net|child_process)|@tobilu\/qmd|node-llama-cpp|better-sqlite3|src\/(?:state|qmd|http|cli|lease)\.ts)/;
for (const [path, input] of Object.entries(result.metafile.inputs)) {
  assert.ok(!forbidden.test(path), `Forbidden Worker input: ${path}`);
  for (const imported of input.imports)
    assert.ok(
      !forbidden.test(imported.path),
      `Forbidden Worker import: ${imported.path}`,
    );
}
const code = result.outputFiles[0]!.text;
assert.ok(!forbidden.test(code), "Forbidden dependency in Worker output");
assert.ok(
  !/sk-(?:proj-|admin-)?[A-Za-z0-9_-]{20,}/.test(code),
  "Credential-shaped literal in Worker output",
);
await mkdir(".worker-build", { recursive: true });
await writeFile(".worker-build/worker.js", code);
await writeFile(
  ".worker-build/metafile.json",
  JSON.stringify(result.metafile, null, 2),
);
console.log(
  `Worker bundle boundary passed: ${Object.keys(result.metafile.inputs).length} inputs, ${Buffer.byteLength(code)} bytes.`,
);
