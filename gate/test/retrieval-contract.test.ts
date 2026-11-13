import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { State } from "../src/state.js";
import { Gateway, encodeReference } from "../src/gateway.js";
import { OpenAIBackend } from "../src/openai.js";
import { publicError } from "../src/errors.js";
import { startServer } from "../src/http.js";
import { mcp } from "../src/cloudflare/mcp.js";
import { toolPayload } from "./tool-payload.js";
const text =
  "\ufeff" +
  Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join("\r\n");
const pdf = Buffer.from("%PDF-1.7\n\x00\xffbinary\n%%EOF", "latin1");
const hash = (b: string | Uint8Array) =>
  createHash("sha256").update(b).digest("hex");
function setup(
  t: any,
  transport?: (url: string, init: RequestInit) => Promise<Response>,
) {
  const dir = mkdtempSync(join(tmpdir(), "retrieval-contract-"));
  const state = new State(dir);
  t.after(() => {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const manifest = JSON.parse(
    readFileSync(
      new URL("./fixtures/wiki-rag-manifest.json", import.meta.url),
      "utf8",
    ),
  );
  manifest.collections.guide.files["README.md"].sha256 = hash(text);
  manifest.collections.second.files["manual.pdf"].sha256 = hash(pdf);
  const binding = {
    projectId: "proj_test",
    credentialEnv: "SYNTHETIC_QUERY_KEY",
    stores: { guide: "vs_test", second: "vs_second" },
  };
  const w = state.importOpenAI("docs", JSON.stringify(manifest), binding);
  state.importOpenAI("hidden", JSON.stringify(manifest), binding);
  state.setPrincipal("reader", { allow: ["docs"], deny: [] });
  const token = state.issueToken("reader", "test", Date.now() + 60000);
  const calls: string[] = [];
  const backend = new OpenAIBackend({
    env: { SYNTHETIC_QUERY_KEY: "sk-proj-synthetic" },
    transport: async (url, init) => {
      calls.push(url);
      if (transport) return transport(url, init);
      if (url.includes("/vector_stores/") && url.endsWith("/content"))
        return Response.json({
          data: [{ type: "text", text }],
          has_more: false,
        });
      if (url.endsWith("/files/file-1/content")) return new Response(text);
      if (url.endsWith("/files/file-4/content"))
        return new Response(pdf, {
          headers: { "content-type": "application/pdf" },
        });
      return Response.json({
        data: url.includes("vs_test")
          ? [
              "x".repeat(1000) + "answer",
              "distinct passage",
              "distinct passage",
            ].map((s) => ({
              file_id: "file-1",
              content: [{ type: "text", text: s }],
            }))
          : [],
        has_more: false,
      });
    },
  });
  const gateway = new Gateway(state, backend);
  const ref = encodeReference("docs", w.generation!, "guide", "README.md");
  const binary = encodeReference("docs", w.generation!, "second", "manual.pdf");
  return { state, token, gateway, ref, binary, calls, w, manifest, binding };
}
test("query preserves the full first-ranked excerpt for each canonical document", async (t) => {
  const { gateway, token } = setup(t);
  const r: any = await gateway.execute(token.id, "query", { query: "answer" });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].snippet, "x".repeat(1000) + "answer");
  assert.equal("excerpts" in r.results[0], false);
  assert.equal(r.results[0].source.repository, "example/guide");
});
test("parsed default and multi_get return complete files; explicit ranges remain bounded", async (t) => {
  const { gateway, token, ref } = setup(t);
  const full: any = await gateway.execute(token.id, "get", { ref });
  assert.equal(full.text, text);
  assert.equal(full.complete, true);
  assert.equal(full.totalLines, 450);
  assert.equal(full.format, "parsed");
  const range: any = await gateway.execute(token.id, "get", {
    ref,
    fromLine: 201,
    maxLines: 2,
  });
  assert.equal(range.text, "line 201\r\nline 202\r");
  assert.equal(range.complete, false);
  assert.equal(range.nextLine, 203);
  const rest: any = await gateway.execute(token.id, "get", {
    ref,
    fromLine: 449,
  });
  assert.equal(rest.text, "line 449\r\nline 450");
  assert.equal(rest.nextLine, null);
  const multi: any = await gateway.execute(token.id, "multi_get", {
    refs: [ref, ref],
  });
  assert.deepEqual(
    multi.documents.map((d: any) => d.text),
    [text, text],
  );
});
test("original text is byte-faithful including BOM and CRLF, with checked digest", async (t) => {
  const { gateway, token, ref, calls } = setup(t);
  const r: any = await gateway.execute(token.id, "get", {
    ref,
    format: "original",
  });
  assert.equal(r.text, text);
  assert.equal(hash(r.text), r.source.sha256);
  assert.equal(r.complete, true);
  assert.equal(r.representation, "original-text");
  assert.equal(r.mimeType, "text/markdown; charset=utf-8");
  assert.ok(calls[0]?.endsWith("/v1/files/file-1/content"));
  await assert.rejects(
    gateway.execute(token.id, "get", { ref, format: "original", maxLines: 2 }),
    { code: "INVALID_INPUT" },
  );
});
for (const transport of ["native", "worker"] as const)
  test(`${transport} MCP carries complete text and original binary once`, async (t) => {
    const { state, gateway, token, binary, ref } = setup(t);
    let call: (args: any) => Promise<any>;
    if (transport === "native") {
      const server = await startServer(state, gateway, 0);
      const client = new Client({ name: "retrieval-contract", version: "1" });
      t.after(async () => {
        await client.close();
        await server.close();
      });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: { Authorization: `Bearer ${token.secret}` } },
        }),
      );
      for (const tool of (await client.listTools()).tools)
        assert.equal(tool.outputSchema, undefined);
      call = async (args) =>
        client.callTool({
          name: args.refs ? "multi_get" : "get",
          arguments: args,
        });
    } else {
      call = async (args) => {
        const parsed = {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: args.refs ? "multi_get" : "get", arguments: args },
        };
        const r = await mcp(
          new Request("https://gate.example/mcp", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            body: JSON.stringify(parsed),
          }),
          parsed,
          state,
          gateway,
          token.id,
          new AbortController().signal,
        );
        return ((await r.json()) as any).result;
      };
    }
    for (const args of [
      { ref },
      { refs: [ref] },
      { ref, format: "original" },
      { ref: binary, format: "original" },
      { refs: [binary, ref], format: "original" },
    ]) {
      const r = CallToolResultSchema.parse(await call(args));
      const payload = toolPayload(r);
      const documents = payload.documents ?? [payload];
      const textDocument = documents.find((d: any) => d.text !== undefined);
      if (textDocument) {
        assert.equal(textDocument.text, text);
        assert.equal(textDocument.complete, true);
        // Count the entire escaped document in the complete tool envelope.
        const escapedText = JSON.stringify(
          JSON.stringify(text).slice(1, -1),
        ).slice(1, -1);
        assert.equal(JSON.stringify(r).split(escapedText).length - 1, 1);
      }
      const resources = r.content.filter((c) => c.type === "resource");
      if (!documents.some((d: any) => d.resource)) {
        assert.equal(resources.length, 0);
        assert.ok(textDocument);
        continue;
      }
      assert.equal(resources.length, 1);
      const resource: any = resources[0]!.resource;
      assert.equal(resource.mimeType, "application/pdf");
      assert.equal(resource.uri, binary);
      assert.deepEqual(Buffer.from(resource.blob, "base64"), pdf);
      assert.equal(
        JSON.stringify(r).split(pdf.toString("base64")).length - 1,
        1,
      );
      assert.ok(!JSON.stringify(payload).includes('"blob"'));
      assert.deepEqual(documents.find((d: any) => d.resource).resource, {
        uri: binary,
        mimeType: "application/pdf",
      });
    }
    state.setPrincipal("reader", { allow: [], deny: [] });
    const denied = await call({ ref: binary, format: "original" });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent, undefined);
    assert.equal(denied.content.length, 1);
    assert.equal(denied.content[0].type, "text");
    assert.ok(!JSON.stringify(denied).includes(pdf.toString("base64")));
  });
test("every format refuses stale, denied, forged and injected file references before access", async (t) => {
  const { gateway, token, ref, w, calls } = setup(t);
  for (const format of ["parsed", "original"]) {
    for (const bad of [
      encodeReference("hidden", w.generation!, "guide", "README.md"),
      encodeReference("docs", "stale", "guide", "README.md"),
    ]) {
      await assert.rejects(
        gateway.execute(token.id, "get", { ref: bad, format }),
      );
      await assert.rejects(
        gateway.execute(token.id, "multi_get", { refs: [ref, bad], format }),
      );
    }
    await assert.rejects(
      gateway.execute(token.id, "get", { ref, format, file_id: "file-stolen" }),
    );
  }
  assert.equal(calls.length, 0);
});
test("incomplete parsed content, original integrity failures and size failures are explicit", async (t) => {
  const partial = setup(t, async () =>
    Response.json({
      data: [{ type: "text", text: "partial" }],
      has_more: true,
    }),
  );
  await assert.rejects(
    partial.gateway.execute(partial.token.id, "get", { ref: partial.ref }),
    { code: "INCOMPLETE_CONTENT" },
  );
  const mismatch = setup(t, async () => new Response("wrong bytes"));
  await assert.rejects(
    mismatch.gateway.execute(mismatch.token.id, "get", {
      ref: mismatch.ref,
      format: "original",
    }),
    { code: "CONTENT_MISMATCH" },
  );
  const huge = setup(
    t,
    async () =>
      new Response("x", {
        headers: { "content-length": String(2 * 1024 * 1024 + 1) },
      }),
  );
  await assert.rejects(
    huge.gateway.execute(huge.token.id, "get", { ref: huge.ref }),
    { code: "CONTENT_TOO_LARGE" },
  );
});

test("full parsed reads exceed the former 64 KiB response cap without clipping", async (t) => {
  const body = Array.from({ length: 450 }, () => "x".repeat(200)).join("\n");
  const { gateway, token, ref } = setup(t, async () =>
    Response.json({ data: [{ type: "text", text: body }], has_more: false }),
  );
  const r: any = await gateway.execute(token.id, "get", { ref });
  assert.equal(r.text, body);
  assert.equal(r.complete, true);
});
test("original delivery is blocked by publication, grant and token changes during download", async (t) => {
  for (const format of ["parsed", "original"])
    for (const change of ["publication", "grant", "token"]) {
      let started!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((r) => (started = r)),
        wait = new Promise<void>((r) => (release = r));
      const f = setup(t, async () => {
        started();
        await wait;
        return format === "original"
          ? new Response(pdf)
          : Response.json({
              data: [{ type: "text", text: "parsed" }],
              has_more: false,
            });
      });
      const pending = f.gateway.execute(f.token.id, "get", {
        ref: f.binary,
        format,
      });
      await entered;
      if (change === "token") f.state.revokeToken(f.token.id);
      else if (change === "grant")
        f.state.setPrincipal("reader", { allow: [], deny: [] });
      else {
        f.manifest.generation++;
        f.manifest.publication_id = "7d0c9d2a-e2ad-45ce-8ff1-c736ffdaf90a";
        f.state.importOpenAI("docs", JSON.stringify(f.manifest), f.binding);
      }
      release();
      await assert.rejects(pending);
    }
});
test("original partial HTTP content and denied provider downloads fail honestly", async (t) => {
  for (const [response, code] of [
    [() => new Response(pdf, { status: 206 }), "INCOMPLETE_CONTENT"],
    [
      () =>
        new Response(pdf, { headers: { "content-range": "bytes 0-23/24" } }),
      "INCOMPLETE_CONTENT",
    ],
    [
      () => new Response("private provider failure", { status: 403 }),
      "ORIGINAL_UNAVAILABLE",
    ],
  ] as const) {
    const f = setup(t, async () => response());
    await assert.rejects(
      f.gateway.execute(f.token.id, "get", {
        ref: f.binary,
        format: "original",
      }),
      { code },
    );
  }
});
test("query overflow is explicit rather than dropping excerpts or returning a clipped answer", async (t) => {
  const f = setup(t, async () =>
    Response.json({
      data: [
        {
          file_id: "file-1",
          content: [{ type: "text", text: "x".repeat(70000) }],
        },
      ],
      has_more: false,
    }),
  );
  await assert.rejects(f.gateway.execute(f.token.id, "query", { query: "x" }), {
    code: "CONTENT_TOO_LARGE",
  });
});
test("MCP exposes actionable fixed errors without provider bodies", async (t) => {
  const f = setup(
    t,
    async () => new Response("private provider failure", { status: 403 }),
  );
  const parsed = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get", arguments: { ref: f.binary, format: "original" } },
  };
  const response = await mcp(
    new Request("https://gate.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(parsed),
    }),
    parsed,
    f.state,
    f.gateway,
    f.token.id,
    new AbortController().signal,
  );
  const wire = await response.text();
  assert.ok(wire.includes("ORIGINAL_UNAVAILABLE"));
  assert.ok(wire.includes("Files content read permission"));
  assert.ok(!wire.includes("private provider failure"));
});

test("unsupported parsed representations return an actionable content error", async (t) => {
  const f = setup(t, async () =>
    Response.json({
      data: [{ type: "image", text: "not parsed text" }],
      has_more: false,
    }),
  );
  await assert.rejects(f.gateway.execute(f.token.id, "get", { ref: f.ref }), {
    code: "UNSUPPORTED_CONTENT",
  });
});

test("a single 33000-character query hit fits without duplicated logical text", async (t) => {
  const passage = "x".repeat(33000);
  const f = setup(t, async () =>
    Response.json({
      data: [{ file_id: "file-1", content: [{ type: "text", text: passage }] }],
      has_more: false,
    }),
  );
  const result: any = await f.gateway.execute(f.token.id, "query", {
    query: "x",
    limit: 1,
  });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].snippet, passage);
  assert.equal("excerpts" in result.results[0], false);
  assert.equal(JSON.stringify(result).split(passage).length - 1, 1);
});

test("partial HTTP signals reject parsed and search JSON even with has_more false", async (t) => {
  for (const tool of ["get", "query"])
    for (const partial of [
      { status: 206 },
      { headers: { "content-range": "bytes 0-99/200" } },
    ]) {
      const f = setup(t, async () =>
        Response.json(
          {
            data:
              tool === "get"
                ? [{ type: "text", text: "partial body" }]
                : [
                    {
                      file_id: "file-1",
                      content: [{ type: "text", text: "partial hit" }],
                    },
                  ],
            has_more: false,
          },
          partial,
        ),
      );
      await assert.rejects(
        f.gateway.execute(
          f.token.id,
          tool,
          tool === "get" ? { ref: f.ref } : { query: "x" },
        ),
        { code: "INCOMPLETE_CONTENT" },
      );
      const parsed = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: tool,
          arguments: tool === "get" ? { ref: f.ref } : { query: "x" },
        },
      };
      const response = await mcp(
        new Request("https://gate.example/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify(parsed),
        }),
        parsed,
        f.state,
        f.gateway,
        f.token.id,
        new AbortController().signal,
      );
      const result = CallToolResultSchema.parse(
        ((await response.json()) as any).result,
      );
      assert.equal(result.isError, true);
      const wire = JSON.stringify(result);
      assert.ok(wire.includes("INCOMPLETE_CONTENT"));
      assert.ok(!wire.includes("partial body"));
      assert.ok(!wire.includes("partial hit"));
      assert.equal(result.structuredContent, undefined);
    }
});

test("original failures preserve only bounded allowlisted provider diagnostics", async (t) => {
  const requestId = "req_0123456789abcdef0123456789abcdef";
  for (const sample of [
    {
      status: 400,
      error: {
        type: "invalid_request_error",
        code: null,
        message: "Not allowed to download files of purpose: assistants",
      },
      expected: {
        status: 400,
        requestId,
        type: "invalid_request_error",
        classification: "purpose_not_downloadable",
      },
    },
    {
      status: 403,
      error: {
        type: "invalid_request_error",
        code: "permission_denied",
        message: "private provider body sk-proj-synthetic",
      },
      expected: {
        status: 403,
        requestId,
        type: "invalid_request_error",
        code: "permission_denied",
      },
    },
    {
      status: 404,
      error: {
        type: "invalid_request_error",
        code: "not_found",
        message: "file-secret missing",
      },
      expected: {
        status: 404,
        requestId,
        type: "invalid_request_error",
        code: "not_found",
      },
    },
    {
      status: 429,
      error: {
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
        message: "private quota",
      },
      expected: {
        status: 429,
        requestId,
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      },
    },
    {
      status: 400,
      error: {
        type: "private-provider-type",
        code: "private-provider-code",
        message:
          "Not allowed to download files of purpose: assistants private suffix",
        param: "private-path",
      },
      expected: { status: 400, requestId },
    },
  ]) {
    const f = setup(t, async () =>
      Response.json(
        { error: sample.error },
        { status: sample.status, headers: { "x-request-id": requestId } },
      ),
    );
    const error: any = await f.gateway
      .execute(f.token.id, "get", { ref: f.ref, format: "original" })
      .then(
        () => assert.fail("must reject"),
        (e) => e,
      );
    assert.equal(error.code, "ORIGINAL_UNAVAILABLE");
    assert.deepEqual(error.diagnostics, sample.expected);
    const wire = publicError(error);
    assert.ok(wire.includes(JSON.stringify(sample.expected)));
    for (const forbidden of [
      "private provider",
      "sk-proj-synthetic",
      "file-secret",
      "private-provider",
      "private-path",
      "private suffix",
      "Not allowed to download files",
    ])
      assert.ok(!wire.includes(forbidden), forbidden);
    assert.equal(f.calls.length, 1);
  }
});

test("invalid and oversized original error bodies cannot escape the diagnostics budget", async (t) => {
  for (const body of [
    "<html>private error page</html>",
    JSON.stringify({
      error: {
        type: "invalid_request_error",
        code: "permission_denied",
        message: "x".repeat(9000),
      },
    }),
  ]) {
    const f = setup(
      t,
      async () =>
        new Response(body, {
          status: 403,
          headers: { "x-request-id": "req_sk-proj-synthetic" },
        }),
    );
    const error: any = await f.gateway
      .execute(f.token.id, "get", { ref: f.ref, format: "original" })
      .then(
        () => assert.fail("must reject"),
        (e) => e,
      );
    assert.deepEqual(error.diagnostics, { status: 403 });
    assert.ok(!publicError(error).includes("req_sk-proj-synthetic"));
    assert.ok(!publicError(error).includes(body));
    assert.equal(f.calls.length, 1);
  }
});

test("many same-document provider hits keep discovery within budget at limit three", async (t) => {
  const first = "quartz ".repeat(800) + "first-ranked answer";
  const f = setup(t, async (url) =>
    Response.json({
      data: Array.from({ length: 50 }, (_, i) => ({
        file_id: url.includes("vs_test")
          ? i === 49
            ? "file-2"
            : "file-1"
          : "file-3",
        content: [
          {
            type: "text",
            text:
              i === 0 || i === 49
                ? first
                : "later passage " + i + " " + "quartz ".repeat(800),
          },
        ],
      })),
      has_more: false,
    }),
  );
  const result: any = await f.gateway.execute(f.token.id, "query", {
    query: "quartz",
    limit: 3,
  });
  assert.equal(result.results.length, 3);
  assert.equal(new Set(result.results.map((hit: any) => hit.ref)).size, 3);
  assert.ok(result.results.every((hit: any) => hit.snippet === first));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 65536);
  assert.equal(f.calls.length, 2);
});

test("native failed original downloads recheck authority before releasing diagnostics", async (t) => {
  for (const change of ["token", "grant", "publication", "none"] as const)
    await t.test(change, async (t) => {
      const requestId = "req_0123456789abcdef0123456789abcdef";
      const f = setup(t, async () => {
        if (change === "token") f.state.revokeToken(f.token.id);
        else if (change === "grant")
          f.state.setPrincipal("reader", { allow: [], deny: [] });
        else if (change === "publication") {
          f.manifest.generation++;
          f.manifest.publication_id = "7d0c9d2a-e2ad-45ce-8ff1-c736ffdaf90a";
          f.state.importOpenAI("docs", JSON.stringify(f.manifest), f.binding);
        }
        return Response.json(
          {
            error: {
              type: "invalid_request_error",
              code: "permission_denied",
              message: "private body",
            },
          },
          { status: 403, headers: { "x-request-id": requestId } },
        );
      });
      const server = await startServer(f.state, f.gateway, 0);
      const client = new Client({
        name: "original-failure-authority",
        version: "1",
      });
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: {
              headers: { Authorization: `Bearer ${f.token.secret}` },
            },
          }),
        );
        const result = CallToolResultSchema.parse(
          await client.callTool({
            name: "get",
            arguments: { ref: f.ref, format: "original" },
          }),
        );
        assert.equal(result.isError, true);
        if (change === "none") {
          const wire = JSON.stringify(result);
          assert.ok(wire.includes("ORIGINAL_UNAVAILABLE"));
          assert.ok(wire.includes(requestId));
          assert.ok(wire.includes("permission_denied"));
        } else {
          const expected = {
            token: "UNAUTHENTICATED",
            grant: "ACCESS_DENIED",
            publication: "CONFLICT",
          }[change];
          assert.deepEqual(result.content, [{ type: "text", text: expected }]);
          assert.equal(result.structuredContent, undefined);
        }
      } finally {
        await client.close();
        await server.close();
      }
    });
});

for (const boundary of ["header", "stream"] as const)
  test(`provider ${boundary} overflow reports its local read limit and cancels`, async (t) => {
    let cancelled = false;
    const f = setup(
      t,
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(2097153));
            },
            cancel() {
              cancelled = true;
            },
          }),
          boundary === "header"
            ? { headers: { "content-length": "2097153" } }
            : {},
        ),
    );
    await assert.rejects(
      f.gateway.execute(f.token.id, "query", { query: "x" }),
      {
        code: "CONTENT_TOO_LARGE",
        diagnostics: { stage: "provider_response", limitBytes: 2097152 },
      },
    );
    assert.equal(cancelled, true);
  });

test("aggregate read output reports the 4 MiB logical tool budget", async (t) => {
  const f = setup(t, async () =>
    Response.json({
      data: [{ type: "text", text: "é".repeat(750000) }],
      has_more: false,
    }),
  );
  await assert.rejects(
    f.gateway.execute(f.token.id, "multi_get", { refs: [f.ref, f.ref, f.ref] }),
    {
      code: "CONTENT_TOO_LARGE",
      diagnostics: { stage: "tool_response", limitBytes: 4194304 },
    },
  );
});

for (const stage of ["provider_response", "tool_response"] as const)
  test(`native MCP delivers safe ${stage} attribution in one text error`, async (t) => {
    const privateText = "private-body-marker ".repeat(
      stage === "provider_response" ? 110000 : 4000,
    );
    const f = setup(t, async () =>
      Response.json({
        data: [
          { file_id: "file-1", content: [{ type: "text", text: privateText }] },
        ],
        has_more: false,
      }),
    );
    const server = await startServer(f.state, f.gateway, 0);
    const client = new Client({ name: "size-attribution", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: {
            headers: { Authorization: `Bearer ${f.token.secret}` },
          },
        }),
      );
      const result = CallToolResultSchema.parse(
        await client.callTool({ name: "query", arguments: { query: "x" } }),
      );
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.equal(result.content.length, 1);
      const content = result.content[0]!;
      assert.equal(content.type, "text");
      assert.ok(content.type === "text");
      assert.match(content.text, /^CONTENT_TOO_LARGE:/);
      assert.ok(content.text.includes(" Diagnostics: "));
      assert.deepEqual(JSON.parse(content.text.split(" Diagnostics: ")[1]!), {
        stage,
        limitBytes: stage === "provider_response" ? 2097152 : 65536,
      });
      for (const secret of [
        "private-body-marker",
        "file-1",
        "proj_test",
        "sk-proj-synthetic",
        "README.md",
      ])
        assert.ok(!JSON.stringify(result).includes(secret));
    } finally {
      await client.close();
      await server.close();
    }
  });
