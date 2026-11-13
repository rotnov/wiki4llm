import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel, Response as MFResponse } from "miniflare";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

// Test-only delivery barrier: exercise the real Worker's last authority check
// after MCP has already serialized either success or a discovery-specific error.
// No test seam, header or network endpoint is added to the production Worker.
test("workerd final guard suppresses discovery success and errors after independent authority/publication changes", async () => {
  const issuer = "https://example.cloudflareaccess.com",
    origin = "https://gate.example";
  const keys = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "test",
    alg: "RS256",
  };
  const source = readFileSync("src/cloudflare/worker.ts", "utf8");
  const anchor = "if (identity.expiresAt <= Date.now()) return response(401);";
  assert.equal(source.split(anchor).length, 2);
  const snapshot = "return this.state.snapshot(w);";
  assert.equal(source.split(snapshot).length, 2);
  const instrumented = source
    .replace(
      anchor,
      `if (request.headers.has("x-test-delivery-pause")) await fetch("https://test-control.example/delivery");\n${anchor}`,
    )
    .replace(
      snapshot,
      `if (request.headers.has("x-test-discovery-error")) throw new GateError("UNSUPPORTED_OPERATION", "private snapshot detail");\n${snapshot}`,
    );
  const script = (
    await build({
      stdin: {
        contents: instrumented,
        resolveDir: process.cwd() + "/src/cloudflare",
        sourcefile: "worker.ts",
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      external: ["node:*", "cloudflare:workers"],
      target: "es2023",
    })
  ).outputFiles[0]!.text;
  let barrier: { enter: () => void; wait: Promise<void> } | undefined;
  let providerRequests = 0;
  const mf = new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    log: new Log(LogLevel.ERROR),
    durableObjects: {
      GATE: { className: "GateDurableObject", useSQLite: true },
    },
    bindings: {
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "test-audience",
      PUBLIC_ORIGIN: origin,
      ADMIN_IDENTITIES: '["user:operator"]',
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.origin === issuer) return MFResponse.json({ keys: [jwk] });
      if (url.origin === "https://test-control.example" && barrier) {
        barrier.enter();
        await barrier.wait;
        return new MFResponse("ok");
      }
      providerRequests++;
      throw Error("No provider traffic permitted");
    },
  });
  async function request(
    path: string,
    body: unknown,
    sub = "operator",
    extra: Record<string, string> = {},
  ) {
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({
      iss: issuer,
      aud: ["test-audience"],
      type: "app",
      sub,
      iat: now,
      exp: now + 600,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test" })
      .sign(keys.privateKey);
    return mf.dispatchFetch(origin + path, {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": jwt,
        "content-type": "application/json",
        ...extra,
      },
      body: JSON.stringify(body),
    });
  }
  async function admin(path: string, body: unknown) {
    const response = await request(path, body);
    assert.equal(response.status, 200, await response.clone().text());
  }
  const manifest = JSON.parse(
    readFileSync(
      new URL("../fixtures/wiki-rag-manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const publish = () =>
    admin("/admin/import", {
      id: "docs",
      binding: {
        projectId: "proj_test",
        credentialEnv: "QUERY_KEY",
        stores: { guide: "vs_test", second: "vs_second" },
      },
      manifestText: JSON.stringify(manifest),
    });
  const principal = (allow = ["docs"]) =>
    admin("/admin/principal", {
      id: "reader",
      grants: { allow, deny: [] },
      enabled: true,
    });
  const identity = (enabled = true) =>
    admin("/admin/identity", {
      key: "user:reader",
      principal: "reader",
      enabled,
    });
  try {
    await principal();
    await identity();
    await publish();
    for (const error of [false, true])
      for (const change of ["grant", "identity", "generation"]) {
        let enter!: () => void, release!: () => void;
        const entered = new Promise<void>((r) => {
            enter = r;
          }),
          wait = new Promise<void>((r) => {
            release = r;
          });
        barrier = { enter, wait };
        const pending = request(
          "/mcp",
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "find_documents",
              arguments: { workspace: "docs", query: "README.md" },
            },
          },
          "reader",
          {
            accept: "application/json, text/event-stream",
            "x-test-delivery-pause": "1",
            ...(error ? { "x-test-discovery-error": "1" } : {}),
          },
        );
        try {
          await entered;
          if (change === "grant") await principal([]);
          if (change === "identity") await identity(false);
          if (change === "generation") {
            manifest.generation++;
            manifest.publication_id = crypto.randomUUID();
            await publish();
          }
        } finally {
          release();
        }
        const response = await pending,
          envelope: any = await response.json(),
          result = envelope.result;
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent, undefined);
        assert.equal(result.content.length, 1);
        assert.equal(
          result.content[0].text,
          {
            generation: "CONFLICT",
            identity: "UNAUTHENTICATED",
            grant: "ACCESS_DENIED",
          }[change],
        );
        for (const secret of [
          "private snapshot detail",
          "UNSUPPORTED_OPERATION",
          "README.md",
          "qgdoc:",
          "file-",
          "vs_test",
          "QUERY_KEY",
        ])
          assert.ok(!JSON.stringify(envelope).includes(secret));
        await principal();
        await identity();
      }
    assert.equal(providerRequests, 0);
  } finally {
    await mf.dispose();
  }
});
