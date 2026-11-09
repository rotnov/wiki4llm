// Test-only bridge: real workerd, synthetic verified Access assertions, no deployed bypass.
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
const gate = process.argv[2];
const require = createRequire(join(gate, "package.json"));
const { build } = require("esbuild");
const { Miniflare, Log, LogLevel, Response: MFResponse } = require("miniflare");
const { generateKeyPair, exportJWK, SignJWT } = await import(
  require.resolve("jose")
);
const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256" };
const issuer = "https://example.cloudflareaccess.com";
const script = (
  await build({
    absWorkingDir: gate,
    entryPoints: ["src/cloudflare/worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["node:*", "cloudflare:workers"],
    target: "es2023",
  })
).outputFiles[0].text;
const persist = mkdtempSync(join(tmpdir(), "wiki-rag-cross-"));
const options = {
  cf: false,
  modules: true,
  script,
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  log: new Log(LogLevel.ERROR),
  durableObjects: { GATE: { className: "GateDurableObject", useSQLite: true } },
  durableObjectsPersist: persist,
  bindings: {
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: "test",
    PUBLIC_ORIGIN: "https://gate.example",
    ADMIN_IDENTITIES: '["user:admin"]',
  },
  outboundService: async () => MFResponse.json({ keys: [jwk] }),
};
let mf = new Miniflare(options);
async function request(input) {
  if (input.control === "restart") {
    await mf.dispose();
    if (input.expire) {
      function files(path) {
        return readdirSync(path, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)],
        );
      }
      const db = new DatabaseSync(
        files(persist).find((p) => p.endsWith(".sqlite")),
      );
      db.exec("UPDATE ingest_authorities SET lease_expires=0");
      db.close();
    }
    mf = new Miniflare(options);
    return { status: 200, body: Buffer.from("{}").toString("base64") };
  }
  const who = input.admin
    ? "user:admin"
    : input.identity || "service:one.access";
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    iss: issuer,
    aud: ["test"],
    type: "app",
    sub: who.startsWith("user:") ? who.slice(5) : "",
    ...(who.startsWith("service:") ? { common_name: who.slice(8) } : {}),
    iat: now,
    exp: now + 600,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .sign(keys.privateKey);
  const response = await mf.dispatchFetch(input.url, {
    method: input.method,
    headers: {
      "cf-access-jwt-assertion": token,
      "content-type": "application/json",
    },
    ...(input.method === "POST"
      ? { body: Buffer.from(input.body, "base64") }
      : {}),
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: Buffer.from(await response.arrayBuffer()).toString("base64"),
  };
}
console.log(JSON.stringify({ ready: true }));
try {
  for await (const line of createInterface({ input: process.stdin })) {
    try {
      console.log(JSON.stringify(await request(JSON.parse(line))));
    } catch (error) {
      console.log(JSON.stringify({ error: error.message }));
    }
  }
} finally {
  await mf.dispose();
  rmSync(persist, { recursive: true, force: true });
}
