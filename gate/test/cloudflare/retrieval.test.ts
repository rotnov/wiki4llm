import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare, Log, LogLevel, Response as MFResponse } from "miniflare";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { encodeReference } from "../../src/gateway.js";
import { toolPayload } from "../tool-payload.js";

test("workerd verifies original hashes and emits exact PDF resources without native dependencies", async () => {
  const pdf = Buffer.from("%PDF-1.7\n\x00\xffsynthetic\n%%EOF", "latin1");
  const text = "\ufeffsource\r\ntext";
  const manifest = JSON.parse(
    readFileSync(
      new URL("../fixtures/wiki-rag-manifest.json", import.meta.url),
      "utf8",
    ),
  );
  manifest.collections.second.files["manual.pdf"].sha256 = createHash("sha256")
    .update(pdf)
    .digest("hex");
  manifest.collections.guide.files["README.md"].sha256 = createHash("sha256")
    .update(text)
    .digest("hex");
  const script = (
    await build({
      stdin: {
        contents: `
      import {Gateway} from './src/gateway.ts';
      import {OpenAIBackend} from './src/openai.ts';
      import {mcp} from './src/cloudflare/mcp.ts';
      const workspace = {id:'docs',generation:'g-1',sources:[],backend:'openai',openai:{
        projectId:'proj_test',credentialEnv:'QUERY_KEY',stores:{guide:'vs_test',second:'vs_second'},manifest:${JSON.stringify(manifest)}
      }};
      const state = {context:()=>({tokenId:'t',principalId:'p',allowed:['docs'],revision:1}),workspace:()=>workspace};
      export default {async fetch(request) {
        const gateway=new Gateway(state,new OpenAIBackend({env:{QUERY_KEY:'sk-fixture00'},transport:(url,init)=>fetch(url,{...init,redirect:'manual'})}));
        return mcp(request,await request.clone().json(),state,gateway,'t',new AbortController().signal);
      }};
    `,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      external: ["node:*", "cloudflare:workers"],
      target: "es2023",
    })
  ).outputFiles[0]!.text;
  const calls: string[] = [];
  const mf = new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    log: new Log(LogLevel.ERROR),
    outboundService: async (req) => {
      calls.push(req.url);
      assert.equal(req.headers.get("authorization"), "Bearer sk-fixture00");
      assert.equal(req.headers.get("openai-project"), "proj_test");
      return req.url.endsWith("/file-4/content")
        ? new MFResponse(pdf)
        : new MFResponse(text);
    },
  });
  try {
    const binary = encodeReference("docs", "g-1", "second", "manual.pdf");
    const ref = encodeReference("docs", "g-1", "guide", "README.md");
    for (const args of [
      { ref: binary, format: "original" },
      { refs: [binary, ref], format: "original" },
    ]) {
      const response = await mf.dispatchFetch("https://gate.example/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "refs" in args ? "multi_get" : "get",
            arguments: args,
          },
        }),
      });
      assert.equal(response.status, 200);
      const wire = (await response.json()) as any;
      const result = CallToolResultSchema.parse(wire.result);
      assert.equal(
        result.isError,
        undefined,
        JSON.stringify({ result, calls }),
      );
      const payload = toolPayload(result);
      const resources = result.content.filter((c) => c.type === "resource");
      assert.equal(resources.length, 1);
      const resource: any = resources[0];
      assert.equal(resource.resource.mimeType, "application/pdf");
      assert.deepEqual(Buffer.from(resource.resource.blob, "base64"), pdf);
      assert.equal(
        JSON.stringify(result).split(pdf.toString("base64")).length - 1,
        1,
      );
      if ("refs" in args) {
        assert.equal(payload.documents[1].text, text);
        assert.equal(payload.documents[1].complete, true);
        const escapedText = JSON.stringify(
          JSON.stringify(text).slice(1, -1),
        ).slice(1, -1);
        assert.equal(JSON.stringify(wire).split(escapedText).length - 1, 1);
      }
    }
    assert.ok(
      calls.every((url) => url.startsWith("https://api.openai.com/v1/files/")),
    );
  } finally {
    await mf.dispose();
  }
});
