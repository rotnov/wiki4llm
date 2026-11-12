import type {
  CallToolResult,
  EmbeddedResource,
} from "@modelcontextprotocol/sdk/types.js";

// Binary bytes appear once as standard MCP resource content, never JSON text.
export function toolResult(output: Record<string, unknown>): CallToolResult {
  const resources: EmbeddedResource[] = [];
  const describe = (value: Record<string, unknown>) => {
    const { resource, ...rest } = value;
    if (!resource) return rest;
    const { uri, mimeType, blob } = resource as {
      uri: string;
      mimeType: string;
      blob: string;
    };
    resources.push({ type: "resource", resource: { uri, mimeType, blob } });
    return { ...rest, resource: { uri, mimeType } };
  };
  const structuredContent = Array.isArray(output.documents)
    ? { ...output, documents: output.documents.map(describe) }
    : describe(output);
  return {
    content: [
      { type: "text", text: JSON.stringify(structuredContent) },
      ...resources,
    ],
    structuredContent,
  };
}
