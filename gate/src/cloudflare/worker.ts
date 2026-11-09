import type { DurableObjectState } from "@cloudflare/workers-types/index.js";
import { z } from "zod";
import { AccessVerifier, validIdentityKey, type Identity } from "./access.js";
import { IngestionState } from "./ingestion.js";
import { CloudState } from "./state.js";
import { mcp } from "./mcp.js";
import { Gateway } from "../gateway.js";
import { OpenAIBackend } from "../openai.js";
import { BoundedQueue } from "../queue.js";
import { GateError } from "../errors.js";
import { uniqueKeys } from "../manifest.js";
interface Binding {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
export interface Env {
  ACCESS_ISSUER: string;
  ACCESS_AUDIENCE: string;
  PUBLIC_ORIGIN: string;
  ADMIN_IDENTITIES: string;
  GATE: Binding;
  [key: string]: unknown;
}
const response = (status: number) =>
  Response.json(
    { error: status },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        ...([409, 429].includes(status) ? { "Retry-After": "1" } : {}),
      },
    },
  );
const paths = new Set([
  "/identity",
  "/mcp",
  "/admin/principal",
  "/admin/identity",
  "/admin/unbind",
  "/admin/import",
  "/admin/status",
  "/admin/publisher",
  "/admin/ingestion",
]);
function route(request: Request, env: Env): string | Response {
  const url = new URL(request.url);
  if (
    !/^https:\/\/[^/]+$/.test(env.PUBLIC_ORIGIN) ||
    url.origin !== env.PUBLIC_ORIGIN ||
    request.headers.has("origin") ||
    request.headers.has("mcp-session-id")
  )
    return response(403);
  const ingest =
    /^\/ingest\/[a-z0-9]+(?:-[a-z0-9]+)*\/(status|publication|lease|snapshot|operations|initialize|checkpoint|publish)$/.test(
      url.pathname,
    );
  if (
    (!paths.has(url.pathname) && !ingest) ||
    (url.search &&
      url.pathname !== "/admin/status" &&
      !url.pathname.endsWith("/publication"))
  )
    return response(404);
  if (
    [...request.headers].reduce((n, [k, v]) => n + k.length + v.length, 0) >
    24576
  )
    return response(431);
  const method =
    url.pathname === "/identity" ||
    url.pathname === "/admin/status" ||
    (ingest && /\/(status|publication)$/.test(url.pathname))
      ? "GET"
      : "POST";
  if (request.method !== method) return response(405);
  return url.pathname;
}
let outerVerifier: AccessVerifier | undefined;
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = route(request, env);
    if (path instanceof Response) return path;
    try {
      if (
        !outerVerifier ||
        outerVerifier.issuer !== env.ACCESS_ISSUER ||
        outerVerifier.audience !== env.ACCESS_AUDIENCE
      )
        outerVerifier = new AccessVerifier(
          env.ACCESS_ISSUER,
          env.ACCESS_AUDIENCE,
        );
      await outerVerifier.verify(
        request.headers.get("cf-access-jwt-assertion") ?? "",
      );
    } catch {
      return response(401);
    }
    // Only the fixed private instance is reachable. Forward the untouched stream:
    // admission and all materialization happen inside that Durable Object.
    try {
      const result = await env.GATE.get(
        env.GATE.idFromName("authority-v1"),
      ).fetch(request);
      const headers = new Headers(result.headers);
      headers.set("Cache-Control", "no-store");
      return new Response(result.body, { status: result.status, headers });
    } catch {
      return response(503);
    }
  },
};
const grants = z
  .object({
    allow: z.array(z.string()).max(100),
    deny: z.array(z.string()).max(100),
  })
  .strict();
const principal = z
  .object({ id: z.string(), grants, enabled: z.boolean() })
  .strict();
const mapping = z
  .object({
    key: z.string().refine(validIdentityKey),
    principal: z.string(),
    enabled: z.boolean(),
  })
  .strict();
const unbind = z.object({ key: z.string().refine(validIdentityKey) }).strict();
const imported = z
  .object({
    id: z.string(),
    binding: z
      .object({
        projectId: z.string(),
        credentialEnv: z.string(),
        stores: z.record(z.string(), z.string()),
      })
      .strict(),
    manifestText: z.string(),
  })
  .strict();
async function readJSON(
  request: Request,
  max: number,
  signal: AbortSignal,
  strict = false,
): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > max)
    throw new GateError("INVALID_INPUT");
  if (!request.body) throw new GateError("INVALID_INPUT");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "",
    size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new GateError("CANCELLED");
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new GateError("INVALID_INPUT");
      text += decoder.decode(value, { stream: true });
    }
    if (signal.aborted) throw new GateError("CANCELLED");
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    if (strict) uniqueKeys(text);
    return value;
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export class GateDurableObject {
  private readonly state: CloudState;
  private readonly verifier: AccessVerifier;
  private readonly ingestion: IngestionState;
  private readonly queue = new BoundedQueue(16, 120000);
  private importing = false;
  private operators = 0;
  constructor(
    ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.state = new CloudState(
      ctx.storage,
      env.ACCESS_ISSUER,
      env.ACCESS_AUDIENCE,
    );
    this.ingestion = new IngestionState(ctx.storage, this.state);
    this.verifier = new AccessVerifier(env.ACCESS_ISSUER, env.ACCESS_AUDIENCE);
  }
  private admin(identity: Identity) {
    let keys: unknown;
    try {
      keys = JSON.parse(this.env.ADMIN_IDENTITIES);
    } catch {
      throw new GateError("ACCESS_DENIED");
    }
    if (
      !Array.isArray(keys) ||
      keys.length > 32 ||
      !keys.every((k) => typeof k === "string" && validIdentityKey(k)) ||
      !keys.includes(identity.key) ||
      identity.issuer !== this.env.ACCESS_ISSUER ||
      identity.expiresAt <= Date.now()
    )
      throw new GateError("ACCESS_DENIED");
  }
  private async ingest(
    request: Request,
    path: string,
    identity: Identity,
  ): Promise<Response> {
    const [, , workspace, action] = path.split("/");
    this.ingestion.authorize(identity, workspace!);
    if (action === "status")
      return Response.json(this.ingestion.status(workspace!));
    if (action === "publication") {
      const url = new URL(request.url);
      if (
        [...url.searchParams.keys()].some(
          (k) => !["generation", "part"].includes(k),
        ) ||
        [...url.searchParams.keys()].length !==
          new Set(url.searchParams.keys()).size
      )
        throw new GateError("INVALID_INPUT");
      const generation = url.searchParams.get("generation"),
        part = url.searchParams.get("part");
      if (
        (generation === null) !== (part === null) ||
        (generation !== null &&
          (!/^o-[a-f0-9]{64}$/.test(generation) ||
            !/^(?:0|[1-9][0-9]?)$/.test(part!)))
      )
        throw new GateError("INVALID_INPUT");
      const value = this.ingestion.publication(
        workspace!,
        generation ?? undefined,
        part === null ? undefined : Number(part),
      );
      return value instanceof Response ? value : Response.json(value);
    }
    const large = action === "publish";
    if (large ? this.importing : this.operators >= 4) return response(429);
    if (large) this.importing = true;
    else this.operators++;
    try {
      const value = await readJSON(
        request,
        large ? 17 * 1024 * 1024 : 512 * 1024,
        AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
        true,
      );
      this.ingestion.authorize(identity, workspace!);
      switch (action) {
        case "lease":
          return Response.json(
            this.ingestion.lease(workspace!, identity, value),
          );
        case "snapshot":
          return Response.json(
            this.ingestion.snapshot(workspace!, identity, value),
          );
        case "operations":
          return Response.json(
            this.ingestion.operations(workspace!, identity, value),
          );
        case "initialize":
          return Response.json(
            this.ingestion.initialize(workspace!, identity, value),
          );
        case "checkpoint":
          return Response.json(
            this.ingestion.checkpoint(workspace!, identity, value),
          );
        case "publish":
          return Response.json(
            this.ingestion.publish(workspace!, identity, value),
          );
        default:
          return response(404);
      }
    } finally {
      if (large) this.importing = false;
      else this.operators--;
    }
  }
  async fetch(request: Request): Promise<Response> {
    const path = route(request, this.env);
    if (path instanceof Response) return path;
    let identity: Identity;
    try {
      identity = await this.verifier.verify(
        request.headers.get("cf-access-jwt-assertion") ?? "",
      );
    } catch {
      return response(401);
    }
    try {
      this.state.checkAuthority();
    } catch {
      return response(503);
    }
    if (path === "/identity")
      return Response.json(
        { issuer: identity.issuer, key: identity.key },
        { headers: { "Cache-Control": "no-store" } },
      );
    try {
      if (path === "/mcp")
        return await this.queue.run(async (signal) => {
          const parsed = await readJSON(
            request,
            128 * 1024,
            AbortSignal.any([signal, AbortSignal.timeout(15000)]),
          );
          const base = this.state.view(identity);
          const selected = new Map<string, string | null>();
          let authorized = false;
          const view = {
            context: (handle: string) => {
              const context = base.context(handle);
              authorized = true;
              return context;
            },
            workspace: (id: string) => {
              const workspace = base.workspace(id);
              if (!selected.has(id)) selected.set(id, workspace.generation);
              return workspace;
            },
          };
          const env = Object.fromEntries(
            Object.entries(this.env).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          );
          const backend = new OpenAIBackend({
            env,
            transport: (url, init) =>
              fetch(url, { ...init, redirect: "manual" }),
            snapshot: (w) => {
              view.context(identity.key);
              return this.state.snapshot(w);
            },
          });
          const result = await mcp(
            request,
            parsed,
            view,
            new Gateway(view, backend),
            identity.key,
            signal,
          );
          if (identity.expiresAt <= Date.now()) return response(401);
          if (authorized) {
            // No awaits between this final authority/generation check and returning bytes.
            const body =
              result.status === 200 ? await result.text() : undefined;
            try {
              view.context(identity.key);
              for (const [id, generation] of selected)
                if (base.workspace(id).generation !== generation)
                  throw new GateError("CONFLICT");
            } catch (error) {
              if (body) {
                const message = JSON.parse(body) as Record<string, unknown>;
                delete message.error;
                message.result = {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text:
                        error instanceof GateError ? error.code : "NOT_FOUND",
                    },
                  ],
                };
                return Response.json(message);
              }
              return response(401);
            }
            if (body !== undefined)
              return new Response(body, {
                status: result.status,
                headers: result.headers,
              });
          }
          return result;
        }, request.signal);
      if (path.startsWith("/ingest/"))
        return await this.ingest(request, path, identity);
      this.admin(identity);
      if (path === "/admin/status") {
        const url = new URL(request.url);
        if (
          [...url.searchParams.keys()].some(
            (k) => !["kind", "after", "limit"].includes(k),
          )
        )
          return response(400);
        const kind = url.searchParams.get("kind") ?? "workspaces",
          after = url.searchParams.get("after") ?? "",
          limit = Number(url.searchParams.get("limit") ?? 20);
        if (
          !["workspaces", "principals", "identities"].includes(kind) ||
          after.length > 300 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 20
        )
          return response(400);
        return Response.json(
          this.state.inventory(
            kind as "workspaces" | "principals" | "identities",
            after,
            limit,
          ),
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      const importing = path === "/admin/import";
      if (importing ? this.importing : this.operators >= 4)
        return response(429);
      if (importing) this.importing = true;
      else this.operators++;
      try {
        const value = await readJSON(
          request,
          importing ? 17 * 1024 * 1024 : 128 * 1024,
          AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
          path === "/admin/publisher" || path === "/admin/ingestion",
        );
        this.admin(identity);
        this.state.checkAuthority();
        switch (path) {
          case "/admin/publisher": {
            this.ingestion.setPublisher(value);
            break;
          }
          case "/admin/ingestion": {
            this.ingestion.provision(value);
            break;
          }
          case "/admin/principal": {
            const a = principal.parse(value);
            this.state.setPrincipal(a.id, a.grants, a.enabled);
            break;
          }
          case "/admin/identity": {
            const a = mapping.parse(value);
            this.state.bind(a.key, a.principal, a.enabled);
            break;
          }
          case "/admin/unbind": {
            const a = unbind.parse(value);
            this.state.unbind(a.key);
            break;
          }
          case "/admin/import": {
            const a = imported.parse(value);
            return Response.json(
              this.state.import(a.id, a.manifestText, a.binding),
            );
          }
          default:
            return response(404);
        }
        return Response.json({ ok: true });
      } finally {
        if (importing) this.importing = false;
        else this.operators--;
      }
    } catch (error) {
      return response(
        error instanceof GateError
          ? error.code === "CONFLICT" &&
            (path.startsWith("/ingest/") ||
              path === "/admin/ingestion" ||
              path === "/admin/import")
            ? 409
            : error.code === "NOT_FOUND" && path.startsWith("/ingest/")
              ? 404
              : error.code === "BUSY"
                ? 429
                : error.code === "ACCESS_DENIED"
                  ? 403
                  : error.code === "UNAUTHENTICATED"
                    ? 401
                    : 400
          : 400,
      );
    }
  }
}
