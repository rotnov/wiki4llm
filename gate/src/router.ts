import type { Backend, SearchMode, ReadFormat } from "./backend.js";
import type { Workspace } from "./state.js";
import { OpenAIBackend } from "./openai.js";
import { GateError } from "./errors.js";
type NativeBackend = Backend & { close(): Promise<void> };
export class RoutedBackend implements Backend {
  private native: Promise<NativeBackend> | undefined;
  private closed = false;
  constructor(
    private readonly dir: string,
    private readonly cloud: Backend = new OpenAIBackend(),
    private readonly openNative: (
      dir: string,
    ) => Promise<NativeBackend> = async (dir) => {
      const { QmdBackend } = await import("./qmd.js");
      return QmdBackend.open(dir);
    },
  ) {}
  private async select(w: Workspace): Promise<Backend> {
    if (this.closed) throw new GateError("NOT_FOUND");
    if (w.backend === "openai") return this.cloud;
    this.native ??= this.openNative(this.dir);
    return this.native;
  }
  async findDocuments(
    w: Workspace,
    query: string,
    repository: string | undefined,
    limit: number,
    signal: AbortSignal,
  ) {
    if (this.closed) throw new GateError("NOT_FOUND");
    if (w.backend !== "openai" || !this.cloud.findDocuments)
      throw new GateError("UNSUPPORTED_OPERATION");
    return this.cloud.findDocuments(w, query, repository, limit, signal);
  }
  async search(
    w: Workspace,
    q: string,
    mode: SearchMode,
    limit: number,
    signal: AbortSignal,
  ) {
    return (await this.select(w)).search(w, q, mode, limit, signal);
  }
  async read(
    w: Workspace,
    c: string,
    p: string,
    signal: AbortSignal,
    format?: ReadFormat,
  ) {
    return (await this.select(w)).read(w, c, p, signal, format);
  }
  async status(w: Workspace, signal: AbortSignal) {
    return (await this.select(w)).status(w, signal);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await (await this.native)?.close();
  }
}
