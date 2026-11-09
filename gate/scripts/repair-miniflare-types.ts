import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
const version = "4.20260730.0";
const originalHash =
  "87ac39f2f429c041f032c81396f97c7b5153a47e7e480e906192b1a5a921d135";
const repairedHash =
  "62daca020ff35bff3864259136a2872daa4350b6000c4ae4c6e8af2c6b63b817";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
// These symbols already have complete declarations in the published bundle.
// Resolve broken generated self-import aliases instead of erasing their types.
const aliases: Record<string, string> = {
  Awaitable_2: "Awaitable",
  ExternalServer_2: "ExternalServer",
  ExternalServer_3: "ExternalServer",
  Json_2: "Json",
  kCurrentWorker_2: "typeof kCurrentWorker",
  kUnsafeEphemeralUniqueKey_2: "typeof kUnsafeEphemeralUniqueKey",
  Log_2: "Log",
  Miniflare_2: "Miniflare",
  Miniflare_3: "Miniflare",
  PeriodType_2: "PeriodType",
  Plugin_2: "Plugin",
  RemoteProxyConnectionString_2: "RemoteProxyConnectionString",
  RemoteProxyConnectionString_3: "RemoteProxyConnectionString",
  Request_3: "Request_2",
  Request_6: "Request_2",
  Response_3: "Response_2",
  Response_6: "Response_2",
  WorkerRegistry_2: "WorkerRegistry",
};
export function repairDeclarations(
  source: string,
  installedVersion: string,
): string {
  if (installedVersion !== version)
    throw new Error(
      "Unexpected Miniflare version; review its declarations before updating the repair.",
    );
  const hash = sha(source);
  if (hash === repairedHash) return source;
  if (hash !== originalHash)
    throw new Error(
      "Unexpected Miniflare declarations; refusing to alter unknown content.",
    );
  let result = source.replace(
    /^import .* from '(?:\.\.|\.\.\/\.\.|\.\/core|\.\/shared|\.\/ratelimit)';\r?\n/gm,
    "",
  );
  for (const [alias, local] of Object.entries(aliases))
    result = result.replace(new RegExp("\\b" + alias + "\\b", "g"), local);
  result = result
    .replace(
      "import { cspotcodeSourceMapSupport } from '@cspotcode/source-map-support';",
      "import * as cspotcodeSourceMapSupport from '@cspotcode/source-map-support';",
    )
    .replace(
      "getFreshSourceMapSupport(): cspotcodeSourceMapSupport;",
      "getFreshSourceMapSupport(): typeof cspotcodeSourceMapSupport;",
    )
    .replaceAll("MockAgent<MockAgent>", "MockAgent")
    .replaceAll("ZodNativeEnum<PeriodType>", "ZodNativeEnum<typeof PeriodType>")
    .replaceAll("from 'zod'", "from 'zod/v3'");
  if (sha(result) !== repairedHash)
    throw new Error(
      "Miniflare declaration repair did not match its reviewed output.",
    );
  return result;
}
export function repairInstalled(root: URL, omitDev: boolean): boolean {
  const packageFile = new URL("node_modules/miniflare/package.json", root);
  if (!existsSync(packageFile)) {
    if (omitDev) return false;
    throw new Error("Required development dependency Miniflare is missing.");
  }
  const declarations = new URL(
    "node_modules/miniflare/dist/src/index.d.ts",
    root,
  );
  const metadata = JSON.parse(readFileSync(packageFile, "utf8")) as {
    version: string;
  };
  const source = readFileSync(declarations, "utf8");
  const repaired = repairDeclarations(source, metadata.version);
  if (repaired !== source) writeFileSync(declarations, repaired);
  return true;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const omitDev =
    process.env.NODE_ENV === "production" ||
    (process.env.npm_config_omit ?? "").split(/[\s,]+/).includes("dev");
  const present = repairInstalled(new URL("../", import.meta.url), omitDev);
  console.log(
    present
      ? "Verified exact Miniflare declaration repair; full TypeScript checking remains enabled."
      : "Production install omits development-only Miniflare.",
  );
}
