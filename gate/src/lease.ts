import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { GateError } from "./errors.js";
export function acquireLease(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, ".process-lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new GateError(
        "CONFLICT",
        "State directory is in use; stop serving before indexing. Inspect a stale lock manually.",
      );
    throw error;
  }
  const owner = JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    nonce: randomUUID(),
  });
  const path = join(lock, "owner.json");
  try {
    writeFileSync(path, owner, { flag: "wx", mode: 0o600 });
  } catch (error) {
    rmSync(lock, { recursive: true, force: true });
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    if (readFileSync(path, "utf8") !== owner)
      throw new GateError("CONFLICT", "State lease owner changed");
    rmSync(lock, { recursive: true });
    released = true;
  };
}
