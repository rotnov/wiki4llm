import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// Consume the public wire contract, not the gateway's internal result object.
export function toolPayload(result: CallToolResult): any {
  assert.equal(result.isError, undefined);
  assert.equal(Object.hasOwn(result, "structuredContent"), false);
  assert.equal(result.content[0]?.type, "text");
  const texts = result.content.filter((item) => item.type === "text");
  assert.equal(texts.length, 1);
  return JSON.parse(texts[0]!.text);
}
