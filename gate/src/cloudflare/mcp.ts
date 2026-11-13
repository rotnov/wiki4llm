import { toolResult } from "../tool-result.js";
import { publicError } from "../errors.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  McpError,
  ErrorCode,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Gateway, toolSchemas, toolDescriptions } from "../gateway.js";
import type { StateReader } from "../state-contract.js";
import { GateError } from "../errors.js";
export async function mcp(
  request: Request,
  parsed: unknown,
  state: StateReader,
  gateway: Gateway,
  handle: string,
  signal: AbortSignal,
): Promise<Response> {
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    ![
      "initialize",
      "notifications/initialized",
      "ping",
      "tools/list",
      "tools/call",
    ].includes(String((parsed as Record<string, unknown>).method))
  )
    return Response.json({ error: 400 }, { status: 400 });
  const server = new Server(
    { name: "wiki-rag-gate", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      state.context(handle);
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        error instanceof GateError ? error.code : "NOT_FOUND",
      );
    }
    return {
      tools: Object.entries(toolSchemas).map(([name, schema]) => ({
        name,
        description: toolDescriptions[name as keyof typeof toolSchemas],
        inputSchema: z.toJSONSchema(schema, { io: "input" }) as any,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      })),
    };
  });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const output = await gateway.execute(
        handle,
        req.params.name,
        req.params.arguments ?? {},
        signal,
      );
      return toolResult(output);
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: publicError(error),
          },
        ],
      };
    }
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, {
      parsedBody: parsed,
    });
    // JSON responses are bounded by Gateway. Materialize before closing the SDK,
    // so cleanup cannot invalidate a body the caller is still consuming.
    const bytes = await response.arrayBuffer();
    return new Response(bytes.byteLength ? bytes : null, {
      status: response.status,
      headers: response.headers,
    });
  } finally {
    await server.close();
  }
}
