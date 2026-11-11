import { z } from "zod";
import { emailAddress } from "../src/email.js";
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const commands = {
  invite: "/admin/invitation",
  "invite-status": "/admin/invitation-status",
  "invite-revoke": "/admin/invitation-revoke",
  identity: "/identity",
  principal: "/admin/principal",
  publisher: "/admin/publisher",
  ingestion: "/admin/ingestion",
  bind: "/admin/identity",
  unbind: "/admin/unbind",
  import: "/admin/import",
  status: "/admin/status",
} as const;
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(80);
const generation = z.string().regex(/^o-[a-f0-9]{64}$/);
const identity = z.string().max(300);
const statusOptions = z
  .object({
    kind: z.enum(["workspaces", "principals", "identities"]).optional(),
    after: z
      .string()
      .max(300)
      .regex(/^[^\x00-\x1f\x7f]*$/)
      .optional(),
    limit: z.number().int().min(1).max(20).optional(),
    issuer: z.string().url().max(256).optional(),
  })
  .strict()
  .refine((value) => value.issuer === undefined || value.kind === "identities");
export type StatusOptions = z.infer<typeof statusOptions>;
const inventory = z
  .object({
    items: z
      .array(
        z.union([
          z
            .object({
              id: slug,
              generation,
              parts: z.number().int().min(1).max(16),
              bytes: z
                .number()
                .int()
                .min(1)
                .max(9 * 1024 * 1024),
            })
            .strict(),
          z
            .object({
              id: slug,
              enabled: z.union([z.literal(0), z.literal(1)]),
              grants_json: z.string().max(16000),
            })
            .strict(),
          z
            .object({
              id: identity,
              principal: slug,
              enabled: z.union([z.literal(0), z.literal(1)]),
            })
            .strict(),
        ]),
      )
      .max(20),
    next: identity.nullable(),
  })
  .strict();
function safeResult(command: AdminCommand, value: unknown): unknown {
  if (command === "invite")
    return z
      .object({
        id: z.string().uuid(),
        url: z
          .string()
          .url()
          .refine((v) => /^https:\/\/[^/]+\/invite\/[a-f0-9]{64}$/.test(v)),
        expiresAt: z.number().int().positive(),
        prompt: z.string().min(1).max(16000),
      })
      .strict()
      .parse(value);
  if (command === "invite-status")
    return z
      .object({
        id: z.string().uuid(),
        email: z.string().refine((v) => emailAddress(v) !== undefined),
        issuer: z.string().url(),
        workspaces: z.array(slug).min(1).max(100),
        expiresAt: z.number().int().positive(),
        status: z.enum(["pending", "accepted", "revoked", "expired"]),
      })
      .strict()
      .parse(value);
  if (command === "identity")
    return z
      .object({ issuer: z.string().url().max(256), key: identity })
      .strict()
      .parse(value);
  if (command === "status") return inventory.parse(value);
  if (command === "import")
    return z
      .object({
        id: slug,
        generation,
        backend: z.literal("openai"),
        sources: z.array(z.never()).max(0),
      })
      .strict()
      .parse(value);
  return z
    .object({ ok: z.literal(true) })
    .strict()
    .parse(value);
}
export type AdminCommand = keyof typeof commands;
export async function adminRequest(
  origin: string,
  command: AdminCommand,
  payload: unknown,
  env: Record<string, string | undefined> = process.env,
  transport: typeof fetch = fetch,
): Promise<unknown> {
  try {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== origin ||
      !Object.hasOwn(commands, command)
    )
      throw Error();
    const headers = new Headers({ "Content-Type": "application/json" });
    if (env.GATE_ACCESS_CLIENT_ID && env.GATE_ACCESS_CLIENT_SECRET) {
      headers.set("CF-Access-Client-Id", env.GATE_ACCESS_CLIENT_ID);
      headers.set("CF-Access-Client-Secret", env.GATE_ACCESS_CLIENT_SECRET);
    } else if (env.GATE_ACCESS_ASSERTION)
      headers.set("Cf-Access-Jwt-Assertion", env.GATE_ACCESS_ASSERTION);
    else throw Error();
    const read = command === "identity" || command === "status";
    const target = new URL(commands[command], origin);
    if (command === "status") {
      const options = statusOptions.parse(payload === undefined ? {} : payload);
      for (const [key, value] of Object.entries(options))
        if (value !== undefined) target.searchParams.set(key, String(value));
    }
    const body = read ? undefined : JSON.stringify(payload);
    if (
      !read &&
      (!body ||
        Buffer.byteLength(body) >
          (command === "import" ? 17 * 1024 * 1024 : 128 * 1024))
    )
      throw Error();
    const response = await transport(target.href, {
      method: read ? "GET" : "POST",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(45000),
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok || response.redirected || !response.body) {
      await response.body?.cancel();
      throw Error();
    }
    const reader = response.body.getReader();
    let text = "",
      size = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 65536) throw Error();
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      return safeResult(command, JSON.parse(text));
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch {
    throw new Error(
      "Administrative request failed; check origin, identity, permissions and input.",
    );
  }
}
export function parseAdminArguments(args: string[]): {
  origin: string;
  command: AdminCommand;
  file?: string;
  status?: StatusOptions;
} {
  const [origin, command, ...rest] = args;
  if (!origin || !command || !Object.hasOwn(commands, command)) throw Error();
  if (command === "status") {
    const values: Record<string, unknown> = {};
    for (let i = 0; i < rest.length; i += 2) {
      const flag = rest[i],
        value = rest[i + 1];
      if (
        !flag ||
        !["--kind", "--after", "--limit", "--issuer"].includes(flag) ||
        value === undefined ||
        value.startsWith("--")
      )
        throw Error();
      const key = flag.slice(2);
      if (Object.hasOwn(values, key)) throw Error();
      values[key] = key === "limit" ? Number(value) : value;
    }
    return { origin, command, status: statusOptions.parse(values) };
  }
  if (command === "identity") {
    if (rest.length) throw Error();
    return { origin, command };
  }
  if (rest.length !== 1 || !rest[0] || rest[0].startsWith("--")) throw Error();
  return { origin, command: command as AdminCommand, file: rest[0] };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const args = parseAdminArguments(process.argv.slice(2));
    let payload: unknown = args.status;
    if (args.file) {
      if ((await stat(args.file)).size > 17 * 1024 * 1024) throw Error();
      payload = JSON.parse(await readFile(args.file, "utf8"));
    }
    const result = await adminRequest(args.origin, args.command, payload);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch {
    process.stderr.write(
      "Administrative request failed. Usage: cloudflare-admin https://host identity|status|principal|publisher|ingestion|bind|unbind|import [input.json]; status supports --kind workspaces|principals|identities --after cursor --limit 1..20; identities also accepts --issuer URL\n",
    );
    process.exitCode = 1;
  }
}
