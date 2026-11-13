import { toolPayload } from "../tool-payload.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import {
  Miniflare,
  Log,
  LogLevel,
  Response as MiniflareResponse,
  type Request as MiniflareRequest,
  type SharedOptions,
  type WorkerOptions,
} from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const issuer = "https://example.cloudflareaccess.com",
  origin = "https://gate.example";
const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test", alg: "RS256" };
const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/wiki-rag-manifest.json", import.meta.url),
    "utf8",
  ),
);
const binding = {
  projectId: "proj_test",
  credentialEnv: "QUERY_KEY",
  stores: { guide: "vs_test", second: "vs_second" },
};
const script = (
  await build({
    entryPoints: ["src/cloudflare/worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["node:*", "cloudflare:workers"],
    target: "es2023",
  })
).outputFiles[0]!.text;
async function jwt(sub = "reader", extra: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: issuer,
    aud: ["test-audience"],
    type: "app",
    sub,
    iat: now,
    exp: now + 600,
    ...extra,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .sign(keys.privateKey);
}
const persist = mkdtempSync(join(tmpdir(), "gate-cf-"));
let requests: string[] = [];
let barrier: { entered: () => void; wait: Promise<void> } | undefined;
const options = (
  overrides: Record<string, string> = {},
): SharedOptions & WorkerOptions => ({
  modules: true,
  script,
  compatibilityDate: "2026-07-30",
  compatibilityFlags: ["nodejs_compat"],
  log: new Log(LogLevel.ERROR),
  durableObjects: { GATE: { className: "GateDurableObject", useSQLite: true } },
  durableObjectsPersist: persist,
  bindings: {
    ACCESS_ISSUER: issuer,
    ACCESS_AUDIENCE: "test-audience",
    PUBLIC_ORIGIN: origin,
    ADMIN_IDENTITIES: '["user:operator"]',
    QUERY_KEY: "sk-fixture00",
    ...overrides,
  },
  outboundService: async (req: MiniflareRequest) => {
    const url = new URL(req.url);
    if (
      url.origin === (overrides.ACCESS_ISSUER ?? issuer) &&
      url.pathname === "/cdn-cgi/access/certs"
    )
      return MiniflareResponse.json({ keys: [jwk] });
    assert.equal(url.origin, "https://api.openai.com");
    requests.push(url.pathname);
    if (barrier) {
      const b = barrier;
      barrier = undefined;
      b.entered();
      await b.wait;
    }
    if (url.pathname.endsWith("/search"))
      return MiniflareResponse.json({
        data: [
          {
            file_id: url.pathname.includes("vs_second") ? "file-3" : "file-1",
            content: [{ type: "text", text: "public fixture" }],
          },
        ],
        has_more: false,
      });
    return MiniflareResponse.json({
      data: [{ type: "text", text: "line one\nline two" }],
      has_more: false,
    });
  },
});
let mf: Miniflare;
async function request(
  path: string,
  body?: unknown,
  sub = "operator",
  extra: Record<string, string> = {},
) {
  return mf.dispatchFetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "cf-access-jwt-assertion": await jwt(sub),
      "content-type": "application/json",
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function rpc(name: string, args: unknown = {}, sub = "reader") {
  const r = await request(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
    sub,
    { accept: "application/json, text/event-stream" },
  );
  assert.equal(r.status, 200, await r.clone().text());
  return ((await r.json()) as any).result;
}
async function principal(id = "reader", allow = ["*"], enabled = true) {
  assert.equal(
    (
      await request("/admin/principal", {
        id,
        grants: { allow, deny: [] },
        enabled,
      })
    ).status,
    200,
  );
}
async function mapping(key = "user:reader", enabled = true) {
  assert.equal(
    (await request("/admin/identity", { key, principal: "reader", enabled }))
      .status,
    200,
  );
}
async function publish(id = "example", manifest = fixture) {
  const r = await request("/admin/import", {
    id,
    binding,
    manifestText: JSON.stringify(manifest),
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json() as Promise<any>;
}
function pause() {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => (enter = r));
  const wait = new Promise<void>((r) => (release = r));
  barrier = { entered: enter, wait };
  return { entered, release };
}
test("real workerd Access, SQLite authority, publication, MCP and independent operator races", async (t) => {
  mf = new Miniflare(options());
  try {
    await t.test(
      "real workerd bounds a stalled JWKS response body",
      async () => {
        await mf.dispose();
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const config = options();
        config.outboundService = async () =>
          new MiniflareResponse(
            new ReadableStream<Uint8Array>({
              start(c) {
                controller = c;
                c.enqueue(new TextEncoder().encode("{"));
              },
            }),
          );
        mf = new Miniflare(config);
        const start = Date.now();
        try {
          const result = await request("/identity", undefined, "reader");
          assert.equal(result.status, 401);
          assert.ok(Date.now() - start < 5000);
        } finally {
          try {
            controller?.close();
          } catch {}
          await mf.dispose();
          mf = new Miniflare(options());
        }
        assert.equal(
          (await request("/identity", undefined, "reader")).status,
          200,
        );
      },
    );
    await t.test(
      "origin authentication and spoofed identity never bypass Access",
      async () => {
        assert.equal(
          (await mf.dispatchFetch(origin + "/identity")).status,
          401,
        );
        assert.equal(
          (
            await mf.dispatchFetch(origin + "/identity", {
              headers: {
                authorization: "Bearer qg_fake",
                "x-gate-identity": "user:operator",
                "cf-access-authenticated-user-email": "operator@example.com",
              },
            })
          ).status,
          401,
        );
        assert.equal(
          (await request("/identity", undefined, "reader")).status,
          200,
        );
        assert.deepEqual(
          await (await request("/identity", undefined, "reader")).json(),
          { issuer, key: "user:reader" },
        );
        assert.equal(
          (await request("/admin/status", undefined, "reader")).status,
          403,
        );
        assert.equal(
          (await request("/identity?object=evil", undefined, "reader")).status,
          404,
        );
      },
    );
    await t.test(
      "authenticated ping uses the SDK without provider access",
      async () => {
        const before = requests.length;
        for (const id of [0, "health-check"]) {
          const result = await request(
            "/mcp",
            { jsonrpc: "2.0", id, method: "ping" },
            "reader",
            { accept: "application/json, text/event-stream" },
          );
          assert.equal(result.status, 200);
          assert.deepEqual(await result.json(), {
            jsonrpc: "2.0",
            id,
            result: {},
          });
          assert.equal(result.headers.get("mcp-session-id"), null);
        }
        assert.equal(requests.length, before);
        // Ping is transport health, so it must not grant an unmapped reader corpus access.
        assert.equal((await rpc("list_workspaces")).isError, true);
        assert.equal(requests.length, before);
      },
    );
    await t.test(
      "ping retains HTTP authentication and invalid-message guards",
      async () => {
        const before = requests.length;
        const ping = { jsonrpc: "2.0", id: 0, method: "ping" };
        assert.equal(
          (
            await mf.dispatchFetch(origin + "/mcp", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
              },
              body: JSON.stringify(ping),
            })
          ).status,
          401,
        );
        assert.equal((await request("/mcp", undefined, "reader")).status, 405);
        for (const body of [
          { ...ping, method: "unknown" },
          { ...ping, jsonrpc: "1.0" },
          { ...ping, id: null },
          { ...ping, params: "invalid" },
          [ping],
        ]) {
          const result = await request("/mcp", body, "reader", {
            accept: "application/json, text/event-stream",
          });
          assert.equal(result.status, 400);
        }
        assert.equal(requests.length, before);
      },
    );
    await t.test(
      "explicit independent admin privilege, strict schema and unknown identity denial",
      async () => {
        assert.equal((await rpc("list_workspaces")).isError, true);
        assert.equal(
          (
            await request("/admin/principal", {
              id: "reader",
              grants: { allow: ["*"], deny: [] },
              enabled: true,
              extra: true,
            })
          ).status,
          400,
        );
        await principal();
        await mapping();
        await publish();
        assert.equal(
          (
            await request("/admin/status", undefined, "reader", {
              "x-gate-identity": "user:operator",
            })
          ).status,
          403,
        );
        assert.equal(
          (await rpc("list_workspaces", {}, "operator")).isError,
          true,
        );
        assert.deepEqual(toolPayload(await rpc("list_workspaces")).workspaces, [
          { id: "example", indexed: true },
        ]);
      },
    );
    await t.test(
      "official stateless SDK client supports consecutive calls and discovery",
      async () => {
        const client = new Client({ name: "test", version: "1" });
        const token = await jwt();
        const transport = new StreamableHTTPClientTransport(
          new URL(origin + "/mcp"),
          {
            requestInit: { headers: { "cf-access-jwt-assertion": token } },
            fetch: async (input, init) => {
              const req = new Request(input, init);
              const res = await mf.dispatchFetch(req.url, {
                method: req.method,
                headers: Object.fromEntries(req.headers),
                ...(req.body ? { body: await req.text() } : {}),
              });
              return new Response(await res.arrayBuffer(), {
                status: res.status,
                headers: Object.fromEntries(res.headers),
              });
            },
          },
        );
        try {
          await client.connect(transport);
          assert.equal((await client.listTools()).tools.length, 6);
          for (let i = 0; i < 3; i++)
            assert.equal(
              (await client.callTool({ name: "status", arguments: {} }))
                .isError,
              undefined,
            );
        } finally {
          await client.close();
        }
      },
    );
    await t.test(
      "query provenance, exact get, forbidden mixed multi_get has zero upstream calls",
      async () => {
        const result = toolPayload(await rpc("query", { query: "fixture" }));
        assert.equal(result.results.length, 2);
        assert.notEqual(result.results[0].ref, result.results[1].ref);
        assert.notEqual(
          result.results[0].source.repository,
          result.results[1].source.repository,
        );
        assert.equal(
          toolPayload(await rpc("get", { ref: result.results[0].ref })).text,
          "line one\nline two",
        );
        const foreign =
          "qgdoc:" +
          Buffer.from(
            JSON.stringify([
              1,
              "forbidden",
              "o-" + "a".repeat(64),
              "guide",
              "README.md",
            ]),
          ).toString("base64url");
        const count = requests.length;
        assert.equal(
          (await rpc("multi_get", { refs: [result.results[0].ref, foreign] }))
            .isError,
          true,
        );
        assert.equal(requests.length, count);
      },
    );
    await t.test(
      "revocation and publication from separately authenticated admin suppress in-flight results",
      async () => {
        let p = pause();
        let pending = rpc("query", { query: "race" });
        await p.entered;
        await mapping("user:reader", false);
        p.release();
        assert.equal((await pending).isError, true);
        await mapping();
        p = pause();
        pending = rpc("query", { query: "race" });
        await p.entered;
        await principal("reader", [], true);
        p.release();
        assert.equal((await pending).isError, true);
        await principal();
        const refs = toolPayload(
          await rpc("query", { query: "fixture" }),
        ).results.map((x: any) => x.ref);
        p = pause();
        pending = rpc("multi_get", { refs });
        await p.entered;
        await publish("example", {
          ...fixture,
          generation: 2,
          publication_id: crypto.randomUUID(),
        });
        p.release();
        assert.equal((await pending).isError, true);
        assert.equal((await rpc("get", { ref: refs[0] })).isError, true);
      },
    );
    await t.test(
      "strict import histories, duplicate keys and immutable bindings fail atomically",
      async () => {
        const current = {
          ...fixture,
          generation: 3,
          publication_id: crypto.randomUUID(),
        };
        await publish("history", fixture);
        await publish("history", current);
        await publish("history", current);
        const before = await (await request("/admin/status")).text();
        for (const manifest of [
          fixture,
          { ...current, project_id: "proj_other" },
          { ...current, generation: 4 },
          { ...current, generation: 4, publication_id: fixture.publication_id },
          { ...current, published_at: "2026-11-08T12:00:00Z" },
        ])
          assert.equal(
            (
              await request("/admin/import", {
                id: "history",
                binding,
                manifestText: JSON.stringify(manifest),
              })
            ).status,
            400,
          );
        assert.equal(
          (
            await request("/admin/import", {
              id: "history",
              binding: { ...binding, credentialEnv: "OTHER_QUERY_KEY" },
              manifestText: JSON.stringify(current),
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await request("/admin/import", {
              id: "history",
              binding,
              manifestText: JSON.stringify(current).replace(
                '"generation":3',
                '"generation":3,"generation":3',
              ),
            })
          ).status,
          400,
        );
        assert.equal(await (await request("/admin/status")).text(), before);
      },
    );
    await t.test(
      "service assertions require their own mapping and cannot inherit human authority",
      async () => {
        const service = await jwt("", { common_name: "automation.access" });
        const body = {
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: { name: "list_workspaces", arguments: {} },
        };
        const headers = {
          accept: "application/json, text/event-stream",
          "cf-access-jwt-assertion": service,
        };
        assert.equal(
          (
            (await (
              await request("/mcp", body, "reader", headers)
            ).json()) as any
          ).result.isError,
          true,
        );
        await mapping("service:automation.access");
        assert.equal(
          (
            (await (
              await request("/mcp", body, "reader", headers)
            ).json()) as any
          ).result.isError,
          undefined,
        );
        assert.equal(
          (await request("/admin/principal", {}, "reader", headers)).status,
          403,
        );
        await request("/admin/unbind", { key: "service:automation.access" });
        assert.equal(
          (
            (await (
              await request("/mcp", body, "reader", headers)
            ).json()) as any
          ).result.isError,
          true,
        );
      },
    );
    await t.test(
      "expired assertion and disabled principal suppress delayed provider response",
      async () => {
        let p = pause();
        const body = {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: {
            name: "query",
            arguments: { query: "expiry", workspaces: ["example"] },
          },
        };
        const pending = request("/mcp", body, "reader", {
          accept: "application/json, text/event-stream",
          "cf-access-jwt-assertion": await jwt("reader", {
            exp: Math.floor(Date.now() / 1000) + 2,
          }),
        });
        await p.entered;
        await new Promise((r) => setTimeout(r, 2100));
        p.release();
        assert.equal((await pending).status, 401);
        p = pause();
        const query = rpc("query", {
          query: "disabled",
          workspaces: ["example"],
        });
        await p.entered;
        await principal("reader", ["*"], false);
        p.release();
        assert.equal((await query).isError, true);
        await principal();
      },
    );
    await t.test(
      "one active and sixteen queued data requests, with independent operator access",
      async () => {
        const p = pause();
        const active = rpc("query", {
          query: "queued",
          workspaces: ["example"],
        });
        await p.entered;
        const queued = [];
        for (let i = 0; i < 16; i++) {
          queued.push(
            request(
              "/mcp",
              {
                jsonrpc: "2.0",
                id: i + 20,
                method: "tools/call",
                params: {
                  name: "status",
                  arguments: { workspaces: ["example"] },
                },
              },
              "reader",
              { accept: "application/json, text/event-stream" },
            ),
          );
          await new Promise((r) => setTimeout(r, 5));
        }
        try {
          const overflow = await request(
            "/mcp",
            {
              jsonrpc: "2.0",
              id: 90,
              method: "tools/call",
              params: { name: "status", arguments: {} },
            },
            "reader",
            { accept: "application/json, text/event-stream" },
          );
          assert.equal(overflow.status, 429);
          const ping = await request(
            "/mcp",
            { jsonrpc: "2.0", id: 0, method: "ping" },
            "reader",
            { accept: "application/json, text/event-stream" },
          );
          assert.equal(ping.status, 429);
          assert.equal((await request("/admin/status")).status, 200);
        } finally {
          p.release();
          await active;
          const responses = await Promise.all(queued);
          assert.ok(responses.every((r) => r.status === 200));
        }
      },
    );
    await t.test(
      "administrative inventory caps response bytes and paginates long grants",
      async () => {
        const patterns = Array.from(
          { length: 100 },
          (_, i) => `workspace-${i}-` + "a".repeat(60),
        );
        for (let i = 0; i < 20; i++)
          await principal(`inventory-${String(i).padStart(2, "0")}`, patterns);
        const page = await request("/admin/status?kind=principals&limit=20");
        const text = await page.text();
        assert.ok(Buffer.byteLength(text) <= 65536);
        const parsed = JSON.parse(text);
        assert.ok(parsed.next);
        const next = await request(
          "/admin/status?kind=principals&after=" +
            encodeURIComponent(parsed.next),
        );
        assert.equal(next.status, 200);
        assert.notEqual(
          ((await next.json()) as any).items[0].id,
          parsed.items[0].id,
        );
      },
    );
    await t.test(
      "one streamed import and four operator bodies admitted before reading",
      async () => {
        let finish!: () => void;
        const wait = new Promise<void>((r) => (finish = r));
        const pending = mf.dispatchFetch(origin + "/admin/import", {
          method: "POST",
          headers: {
            "cf-access-jwt-assertion": await jwt("operator"),
            "content-type": "application/json",
          },
          body: new ReadableStream({
            async start(c) {
              c.enqueue(new TextEncoder().encode("{"));
              await wait;
              c.enqueue(new TextEncoder().encode("}"));
              c.close();
            },
          }),
          duplex: "half",
        });
        let busy = false;
        try {
          for (let n = 0; n < 30; n++) {
            const r = await request("/admin/import", {});
            if (r.status === 429) {
              assert.equal(r.headers.get("retry-after"), "1");
              busy = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 5));
          }
          assert.ok(busy);
          await principal();
        } finally {
          finish();
          await pending;
        }
        const releases: Array<() => void> = [];
        const small = [];
        for (let i = 0; i < 4; i++) {
          let release!: () => void;
          const wait = new Promise<void>((r) => (release = r));
          releases.push(release);
          small.push(
            mf.dispatchFetch(origin + "/admin/principal", {
              method: "POST",
              headers: { "cf-access-jwt-assertion": await jwt("operator") },
              body: new ReadableStream({
                async start(c) {
                  c.enqueue(new TextEncoder().encode("{"));
                  await wait;
                  c.enqueue(new TextEncoder().encode("}"));
                  c.close();
                },
              }),
              duplex: "half",
            }),
          );
        }
        try {
          let busy = false;
          for (let n = 0; n < 30; n++) {
            if ((await request("/admin/principal", {})).status === 429) {
              busy = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 5));
          }
          assert.ok(busy);
        } finally {
          releases.forEach((r) => r());
          await Promise.all(small);
        }
      },
    );
    await t.test(
      "stalled streamed bodies expire and release import and operator admission",
      async () => {
        const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
        const start = Date.now();
        const send = async (path: string) =>
          mf.dispatchFetch(origin + path, {
            method: "POST",
            headers: { "cf-access-jwt-assertion": await jwt("operator") },
            body: new ReadableStream<Uint8Array>({
              start(c) {
                controllers.push(c);
                c.enqueue(new TextEncoder().encode("{"));
              },
            }),
            duplex: "half",
          });
        const importing = send("/admin/import"),
          operating = send("/admin/principal");
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          const results = await Promise.race([
            Promise.all([importing, operating]),
            new Promise<never>((_, reject) => {
              deadline = setTimeout(
                () => reject(Error("body deadlines exceeded")),
                35000,
              );
            }),
          ]);
          assert.ok(Date.now() - start >= 25000);
          assert.ok(results.every((r) => r.status === 400));
          assert.equal((await request("/admin/import", {})).status, 400);
          await principal();
        } finally {
          clearTimeout(deadline);
          for (const c of controllers)
            try {
              c.close();
            } catch {}
        }
      },
    );
    await t.test(
      "largest valid import with active large retrieval and twenty metadata-only selectors",
      async () => {
        const large = structuredClone(fixture);
        const c = large.collections.guide;
        delete large.collections.second;
        c.files = {};
        for (let i = 0; i < 10000; i++) {
          const path =
            `${i}-` + String.fromCodePoint(0x6587).repeat(36) + ".md";
          c.files[path] = {
            ...fixture.collections.guide.files["README.md"],
            path,
            file_id: `file-${i}`,
            operation_id: "x".repeat(256),
          };
        }
        const largeBinding = { ...binding, stores: { guide: "vs_test" } };
        let text = JSON.stringify(large);
        assert.ok(Buffer.byteLength(text) < 8 * 1024 * 1024);
        text += " ".repeat(8 * 1024 * 1024 - Buffer.byteLength(text));
        assert.equal(Buffer.byteLength(text), 8 * 1024 * 1024);
        async function put(id: string) {
          const r = await request("/admin/import", {
            id,
            binding: largeBinding,
            manifestText: text,
          });
          assert.equal(r.status, 200, await r.clone().text());
        }
        await put("large");
        const p = pause();
        const active = rpc("query", { query: "large", workspaces: ["large"] });
        await p.entered;
        try {
          await put("large-copy");
        } finally {
          p.release();
        }
        assert.equal((await active).isError, undefined);
        const status = (await (await request("/admin/status")).json()) as any;
        assert.ok(status.items.find((x: any) => x.id === "large").parts > 1);
        for (let i = 0; i < 18; i++) await put(`large-${i}`);
        const ids = [
          "large",
          "large-copy",
          ...Array.from({ length: 18 }, (_, i) => `large-${i}`),
        ];
        assert.equal(
          toolPayload(await rpc("status", { workspaces: ids })).workspaces
            .length,
          20,
        );
        const query = await rpc("query", { query: "large", workspaces: ids });
        assert.equal(toolPayload(query).searchedWorkspaces.length, 20);
        await mf.dispose();
        mf = new Miniflare(options());
        assert.equal(
          toolPayload(await rpc("status", { workspaces: ["large"] }))
            .workspaces[0].documents,
          10000,
        );
      },
    );
    await t.test(
      "atomic import rejection and durable restart authority binding",
      async () => {
        const before = await (await request("/admin/status")).json();
        assert.equal(
          (
            await request("/admin/import", {
              id: "example",
              binding,
              manifestText: JSON.stringify(fixture),
            })
          ).status,
          400,
        );
        assert.deepEqual(await (await request("/admin/status")).json(), before);
        await mf.dispose();
        mf = new Miniflare(options());
        assert.equal(
          toolPayload(await rpc("status", { workspaces: ["example"] }))
            .workspaces[0].id,
          "example",
        );
        await mf.dispose();
        mf = new Miniflare(options({ ACCESS_AUDIENCE: "changed" }));
        const wrong = await jwt("reader", { aud: ["changed"] });
        assert.equal(
          (
            await mf.dispatchFetch(origin + "/identity", {
              headers: { "cf-access-jwt-assertion": wrong },
            })
          ).status,
          503,
        );
        await mf.dispose();
        mf = new Miniflare(
          options({
            ACCESS_ISSUER: "https://replacement.cloudflareaccess.com",
          }),
        );
        const changedIssuer = await jwt("reader", {
          iss: "https://replacement.cloudflareaccess.com",
        });
        assert.equal(
          (
            await mf.dispatchFetch(origin + "/identity", {
              headers: { "cf-access-jwt-assertion": changedIssuer },
            })
          ).status,
          503,
        );
        await mf.dispose();
        mf = new Miniflare(options());
      },
    );
    await t.test(
      "missing snapshot chunks fail closed after restart",
      async () => {
        await mf.dispose();
        let changed = false;
        for (const path of readdirSync(persist, {
          recursive: true,
          encoding: "utf8",
        }).filter((p) => p.endsWith(".sqlite"))) {
          const db = new DatabaseSync(join(persist, path));
          try {
            if (
              db
                .prepare(
                  "SELECT name FROM sqlite_master WHERE type='table' AND name='parts'",
                )
                .get()
            ) {
              const deleted = db
                .prepare("DELETE FROM parts WHERE workspace='large' AND part=1")
                .run();
              if (Number(deleted.changes) > 0) changed = true;
            }
          } finally {
            db.close();
          }
        }
        assert.ok(changed);
        mf = new Miniflare(options());
        assert.equal(
          (await rpc("status", { workspaces: ["large"] })).isError,
          true,
        );
      },
    );
    await t.test(
      "published-path discovery uses hosted snapshots and zero provider requests",
      async () => {
        const count = requests.length;
        const wire = await rpc("find_documents", {
          workspace: "example",
          query: " readme.MD ",
        });
        const found = toolPayload(wire);
        assert.equal(wire.structuredContent, undefined);
        assert.equal(wire.content.length, 1);
        assert.equal(found.results.length, 2);
        assert.equal(found.hasMore, false);
        for (const d of found.results) {
          assert.equal(d.path, "README.md");
          assert.equal(d.source.lineBasis, "none");
          assert.equal(d.body, undefined);
          assert.equal(d.snippet, undefined);
        }
        assert.equal(requests.length, count);
        for (const workspace of ["hidden", "missing"]) {
          await principal("reader", ["example"]);
          const denied = await rpc("find_documents", {
            workspace,
            query: "README",
          });
          assert.equal(denied.content[0].text, "ACCESS_DENIED");
        }
        await principal();
        const ref = found.results[0].ref;
        assert.equal(
          toolPayload(await rpc("get", { ref })).text,
          "line one\nline two",
        );
        assert.equal(
          toolPayload(await rpc("multi_get", { refs: [ref] })).documents.length,
          1,
        );
        const m = structuredClone(fixture);
        const c = m.collections.guide,
          template = c.files["README.md"];
        c.files = Object.fromEntries(
          Array.from({ length: 21 }, (_, i) => {
            const path = `nested-${i}/README.md`;
            return [path, { ...template, path, file_id: `file-extra-${i}` }];
          }),
        );
        await publish("discovery", m);
        const n = requests.length;
        const capped = toolPayload(
          await rpc("find_documents", {
            workspace: "discovery",
            query: "README.md",
            limit: 20,
          }),
        );
        assert.equal(capped.results.length, 20);
        assert.equal(capped.hasMore, true);
        const target = toolPayload(
          await rpc("find_documents", {
            workspace: "discovery",
            query: "README.md",
            repository: "example/second",
          }),
        );
        assert.equal(target.results.length, 1);
        assert.equal(target.hasMore, false);
        assert.equal(target.results[0].source.repository, "example/second");
        assert.deepEqual(
          toolPayload(
            await rpc("find_documents", {
              workspace: "discovery",
              query: "README.md",
              repository: "unknown",
            }),
          ),
          { results: [], hasMore: false },
        );
        await publish("discovery", {
          ...m,
          generation: 2,
          publication_id: crypto.randomUUID(),
        });
        const stale = await rpc("get", { ref: target.results[0].ref });
        assert.equal(stale.content[0].text, "NOT_FOUND");
        await principal("reader", ["example"]);
        const denied = await rpc("get", { ref: target.results[0].ref });
        assert.equal(denied.content[0].text, "ACCESS_DENIED");
        await principal();
        assert.equal(requests.length, n);
      },
    );
  } finally {
    await mf.dispose();
    rmSync(persist, { recursive: true, force: true });
  }
});
