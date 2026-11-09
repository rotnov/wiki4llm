import { createServer, type IncomingMessage } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Gateway, toolSchemas, toolDescriptions } from "./gateway.js";
import { State } from "./state.js";
import { BoundedQueue } from "./queue.js";
import { GateError } from "./errors.js";
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 131072) throw new GateError("INVALID_INPUT", "Body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
export interface ListenOptions {
  bindHost?: "127.0.0.1" | "0.0.0.0";
  allowedHosts?: string[];
}
export async function startServer(
  state: State,
  gateway: Gateway,
  port = 8787,
  options: ListenOptions = {},
) {
  const bindHost = options.bindHost ?? "127.0.0.1";
  if (!["127.0.0.1", "0.0.0.0"].includes(bindHost))
    throw new GateError("INVALID_INPUT", "Invalid bind address");
  if (
    options.allowedHosts &&
    (!options.allowedHosts.length ||
      options.allowedHosts.some(
        (host) =>
          !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/.test(host) ||
          Number(host.split(":")[1] ?? 0) > 65535,
      ))
  )
    throw new GateError("INVALID_INPUT", "Invalid allowed authority");
  let allowedHosts: string[] = [];
  const queue = new BoundedQueue();
  let authority = "";
  const http = createServer(async (req, res) => {
    const reject = (status: number) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ error: status }));
    };
    if (req.url !== "/mcp") {
      reject(404);
      return;
    }
    if (
      !allowedHosts.includes(req.headers.host ?? "") ||
      req.headers.origin !== undefined ||
      req.headers["mcp-session-id"] !== undefined
    ) {
      reject(403);
      return;
    }
    let tokenId: string;
    try {
      tokenId = state.authenticate(req.headers.authorization).tokenId;
    } catch {
      reject(401);
      return;
    }
    if (req.method !== "POST") {
      reject(405);
      return;
    }
    if (Number(req.headers["content-length"] ?? 0) > 131072) {
      reject(413);
      return;
    }
    let parsed: unknown;
    try {
      parsed = await body(req);
    } catch (error) {
      if (!res.destroyed) reject(error instanceof GateError ? 413 : 400);
      return;
    }
    // JSON-RPC batches and arbitrary notifications are not part of this gate contract.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      reject(400);
      return;
    }
    const message = parsed as Record<string, unknown>;
    if (
      ![
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
      ].includes(String(message.method))
    ) {
      reject(400);
      return;
    }
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const server = new Server(
      { name: "wiki-rag-gate", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      state.context(tokenId);
      return {
        tools: Object.entries(toolSchemas).map(([name, schema]) => ({
          name,
          description: toolDescriptions[name as keyof typeof toolSchemas],
          inputSchema: z.toJSONSchema(schema) as any,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
          },
        })),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        const output = await queue.run(
          (signal) =>
            gateway.execute(
              tokenId,
              request.params.name,
              request.params.arguments ?? {},
              signal,
            ),
          abort.signal,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (error) {
        const code = error instanceof GateError ? error.code : "NOT_FOUND";
        return { isError: true, content: [{ type: "text", text: code }] };
      }
    });
    res.once("close", () => {
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch {
      if (!res.headersSent) reject(400);
      else res.end();
    }
  });
  http.requestTimeout = 15000;
  http.headersTimeout = 10000;
  http.maxHeadersCount = 40;
  http.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, bindHost, () => {
      http.removeListener("error", reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("Missing listening address");
  authority = `127.0.0.1:${address.port}`;
  allowedHosts = options.allowedHosts ? [...options.allowedHosts] : [authority];
  return {
    url: `http://${authority}/mcp`,
    async close() {
      const done = new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
      http.closeAllConnections();
      await queue.close();
      await done;
    },
  };
}
