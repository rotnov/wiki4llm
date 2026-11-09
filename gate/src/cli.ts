#!/usr/bin/env node
import { parseArgs } from "node:util";
import { writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { State } from "./state.js";
import { QmdBackend } from "./qmd.js";
import { RoutedBackend } from "./router.js";
import { MAX_MANIFEST_BYTES } from "./manifest.js";
import { Gateway } from "./gateway.js";
import { startServer } from "./http.js";
import { acquireLease } from "./lease.js";
import { GateError, invalid } from "./errors.js";
process.umask(0o077);
async function main() {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      state: { type: "string", default: ".data" },
      id: { type: "string" },
      source: { type: "string", multiple: true },
      manifest: { type: "string" },
      project: { type: "string" },
      "credential-env": { type: "string" },
      store: { type: "string", multiple: true },
      allow: { type: "string" },
      deny: { type: "string" },
      disabled: { type: "boolean" },
      principal: { type: "string" },
      name: { type: "string" },
      out: { type: "string" },
      days: { type: "string", default: "30" },
      embed: { type: "boolean" },
      port: { type: "string", default: "8787" },
      bind: { type: "string", default: "127.0.0.1" },
      authority: { type: "string", multiple: true },
    },
  });
  const required = (value: string | undefined) => {
    if (!value) invalid("Missing required option");
    return value;
  };
  const rules = (value: string | undefined) => (value ? value.split(",") : []);
  const command = positionals[0];
  if (
    positionals.length !== 1 ||
    ![
      "workspace",
      "principal",
      "token",
      "revoke",
      "index",
      "serve",
      "import-openai",
    ].includes(command ?? "")
  )
    invalid(
      "Commands: workspace, principal, token, revoke, index, serve, import-openai",
    );
  const state = new State(v.state);
  let backend: QmdBackend | RoutedBackend | undefined,
    release: (() => void) | undefined;
  try {
    switch (command) {
      case "import-openai": {
        const stores: Record<string, string> = {};
        for (const value of v.store ?? []) {
          const match = /^([^=]+)=([^=]+)$/.exec(value);
          if (!match || Object.hasOwn(stores, match[1]!))
            invalid("Use distinct --store collection=vector_store_id bindings");
          Object.defineProperty(stores, match[1]!, {
            value: match[2],
            enumerable: true,
          });
        }
        const fd = openSync(required(v.manifest), "r"),
          data = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
        let size = 0;
        try {
          while (size < data.length) {
            const n = readSync(fd, data, size, data.length - size, null);
            if (!n) break;
            size += n;
          }
        } finally {
          closeSync(fd);
        }
        if (size > MAX_MANIFEST_BYTES) invalid("Manifest exceeds 8 MiB");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          data.subarray(0, size),
        );
        const w = state.importOpenAI(required(v.id), text, {
          projectId: required(v.project),
          credentialEnv: required(v["credential-env"]),
          stores,
        });
        console.log(`Imported ${w.id}: ${w.generation}`);
        break;
      }
      case "workspace": {
        const sources = (v.source ?? []).map((value) => {
          const split = value.indexOf("=");
          if (split < 1) invalid("Use --source name=/absolute/path");
          return {
            name: value.slice(0, split),
            path: resolve(value.slice(split + 1)),
          };
        });
        if (!sources.length) invalid("At least one source is required");
        release = acquireLease(state.dir);
        state.setWorkspace(required(v.id), sources);
        break;
      }
      case "principal":
        state.setPrincipal(
          required(v.id),
          { allow: rules(v.allow), deny: rules(v.deny) },
          !v.disabled,
        );
        break;
      case "token": {
        const out = required(v.out),
          days = Number(v.days);
        if (!Number.isInteger(days) || days < 1 || days > 365)
          invalid("Token days must be 1..365");
        const token = state.issueToken(
          required(v.principal),
          required(v.name),
          Date.now() + days * 86400000,
          v.allow !== undefined || v.deny !== undefined
            ? { allow: rules(v.allow), deny: rules(v.deny) }
            : undefined,
        );
        try {
          writeFileSync(out, JSON.stringify(token, null, 2) + "\n", {
            mode: 0o600,
            flag: "wx",
          });
        } catch (error) {
          state.revokeToken(token.id);
          throw error;
        }
        console.log(
          "Credential written to requested file; value is not printed.",
        );
        break;
      }
      case "revoke":
        state.revokeToken(required(v.id));
        break;
      case "index": {
        const workspaces = v.id
          ? [state.workspace(v.id)]
          : state.workspaces().filter((w) => w.backend !== "openai");
        if (workspaces.some((w) => w.backend === "openai"))
          invalid(
            "OpenAI workspaces require manifest import, not local indexing",
          );
        release = acquireLease(state.dir);
        backend = await QmdBackend.open(state.dir);
        for (const w of workspaces) {
          const generation = await backend.index(w, Boolean(v.embed));
          state.publishGeneration(w.id, generation);
          console.log(`Indexed ${w.id}: ${generation}`);
        }
        break;
      }
      case "serve": {
        const port = Number(v.port);
        if (!Number.isInteger(port) || port < 0 || port > 65535)
          invalid("Invalid port");
        if (v.bind !== "127.0.0.1" && v.bind !== "0.0.0.0")
          invalid("Invalid bind address");
        release = acquireLease(state.dir);
        backend = new RoutedBackend(state.dir);
        const server = await startServer(
          state,
          new Gateway(state, backend),
          port,
          {
            bindHost: v.bind,
            ...(v.authority ? { allowedHosts: v.authority } : {}),
          },
        );
        console.log(`MCP listening at ${server.url}`);
        await new Promise<void>((resolve) => {
          const stop = () => {
            // Keep handlers registered through cleanup: signal-exit (loaded by
            // native inference) otherwise replays this signal and kills us before
            // model disposal and lease release complete. Repeated signals are safe.
            resolve();
          };
          process.on("SIGINT", stop);
          process.on("SIGTERM", stop);
        });
        await server.close();
        break;
      }
    }
  } finally {
    await backend?.close();
    release?.();
    state.close();
  }
}
main().catch((error) => {
  console.error(
    error instanceof GateError
      ? `${error.code}: ${error.message}`
      : "Operation failed; check local configuration and filesystem permissions.",
  );
  process.exitCode = 1;
});
