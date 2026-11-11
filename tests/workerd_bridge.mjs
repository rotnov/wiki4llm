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
    stdin: {resolveDir:gate,contents:`import worker,{GateDurableObject as Base} from './src/cloudflare/worker.ts';
      export default worker;
      export class GateDurableObject extends Base {
        constructor(ctx,env){super(ctx,env);this.testStorage=ctx.storage;}
        async fetch(req){
          if(new URL(req.url).pathname==='/test-only/alarm'){
            this.testStorage.sql.exec("UPDATE ingest_jobs SET next_at=0 WHERE status='pending'");
            await this.alarm();
            return Response.json(this.testStorage.sql.exec('SELECT id,status,error,total,completed FROM ingest_jobs').toArray());
          }
          return super.fetch(req);
        }
      }`},
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["node:*", "cloudflare:workers"],
    target: "es2023",
  })
).outputFiles[0].text;
const persist = mkdtempSync(join(tmpdir(), "wiki-rag-cross-"));
let providerFiles=[];
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
    QUERY_KEY:"synthetic",
  },
  outboundService: async (request) => {
    const url=new URL(request.url);
    if(url.hostname!=="api.openai.com")return MFResponse.json({keys:[jwk]});
    if(request.method!=="GET")throw new Error('background provider mutation');
    const store=url.pathname.split('/')[3];
    const all=providerFiles.filter(f=>f.vector_store_id===store);
    const after=url.searchParams.get('after');
    const start=after?all.findIndex(f=>f.id===after)+1:0;
    const data=all.slice(start,start+100);
    return MFResponse.json({data,has_more:start+data.length<all.length,last_id:data.at(-1)?.id});
  },
};
let mf = new Miniflare(options);
async function request(input) {
  if(input.control==='complete'||input.control==='tick'){
    providerFiles=input.files;
    const ns=await mf.getDurableObjectNamespace('GATE');const stub=ns.get(ns.idFromName('authority-v1'));
    for(let i=0;i<120;i++){
      const response=await stub.fetch('https://gate.example/test-only/alarm');
      const jobs=await response.json();
      if(input.control==='tick'||jobs.every(j=>j.status!=='pending'))return {status:200,body:Buffer.from(JSON.stringify(jobs)).toString('base64')};
    }
    throw new Error('background did not complete within bounded test ticks');
  }
  if (input.control === "restart") {
    await mf.dispose();
    if (input.expire || input.legacy_timing) {
      function files(path) {
        return readdirSync(path, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)],
        );
      }
      const db = new DatabaseSync(
        files(persist).find((p) => p.endsWith(".sqlite")),
      );
      if(input.expire)db.exec("UPDATE ingest_authorities SET lease_expires=0");
      if(input.legacy_timing)db.exec("ALTER TABLE ingest_jobs DROP COLUMN finished_at");
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
