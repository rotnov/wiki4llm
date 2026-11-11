import type { DurableObjectStorage } from "@cloudflare/workers-types/index.js";
import { uniqueKeys } from "../manifest.js";
import {
  BackgroundFailure,
  IngestionState,
  type BackgroundJob,
  type ProviderFilePage,
} from "./ingestion.js";
import type { Identity } from "./access.js";

class ProviderRetry extends Error {}

/** Durable completion; the CI publisher never waits for provider indexing. */
export class BackgroundFinalizer {
  private scheduling: Promise<void> = Promise.resolve();
  constructor(
    private storage: DurableObjectStorage,
    private ingestion: IngestionState,
    private env: Record<string, unknown>,
  ) {}

  private schedule(prearm = false): Promise<void> {
    const action = async () => {
      const next = this.ingestion.nextJobTime();
      if (prearm) {
        const existing = await this.storage.getAlarm();
        await this.storage.setAlarm(
          Math.max(
            Date.now() + 1,
            Math.min(existing ?? Infinity, Date.now() + 1000, next ?? Infinity),
          ),
        );
      } else if (next !== null) {
        await this.storage.setAlarm(Math.max(Date.now() + 1, next));
      } else await this.storage.deleteAlarm();
    };
    const result = this.scheduling.then(action, action);
    this.scheduling = result.catch(() => {});
    return result;
  }

  async submit(workspace: string, identity: Identity, value: unknown) {
    // Arm before the synchronous SQLite commit, including idempotent replay.
    // A crash may leave a harmless alarm, never an accepted job without a wakeup.
    await this.schedule(true);
    const result = this.ingestion.submit(workspace, identity, value);
    await this.schedule();
    return result;
  }

  async alarm() {
    // Cloudflare alarms are at-least-once. Re-arm before any provider await.
    await this.schedule(true);
    try {
      const job = this.ingestion.dueJob();
      if (!job) return;
      try {
        if (this.ingestion.completeReadyJob(job)) return;
        const page = await this.page(job);
        this.ingestion.applyJobPage(job, page);
      } catch (error) {
        if (error instanceof ProviderRetry)
          this.ingestion.failJob(job, "provider_retry", true);
        else if (error instanceof BackgroundFailure)
          this.ingestion.failJob(job, error.code, false, error.fileId);
        else this.ingestion.failJob(job, "finalization_error", false);
      }
    } finally {
      await this.schedule();
    }
  }

  private async page(job: BackgroundJob): Promise<ProviderFilePage> {
    const key = this.env[job.binding.credentialEnv];
    if (typeof key !== "string" || !key || /[\r\n]/.test(key))
      throw new BackgroundFailure("provider_credential_missing");
    const url = new URL(
      `https://api.openai.com/v1/vector_stores/${job.store}/files`,
    );
    url.searchParams.set("limit", "100");
    url.searchParams.set("order", "asc");
    if (job.after) url.searchParams.set("after", job.after);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${key}`,
          "OpenAI-Project": job.binding.projectId,
          "OpenAI-Beta": "assistants=v2",
        },
      });
    } catch {
      throw new ProviderRetry();
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      throw new ProviderRetry();
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new BackgroundFailure(
        response.status === 401 || response.status === 403
          ? "provider_access_denied"
          : "provider_response",
      );
    }
    if (!response.body) throw new BackgroundFailure("provider_response");
    const reader = response.body.getReader(),
      decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0,
      text = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 512 * 1024)
          throw new BackgroundFailure("provider_response_size");
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      const page = JSON.parse(text) as ProviderFilePage;
      uniqueKeys(text);
      if (
        !page ||
        !Array.isArray(page.data) ||
        page.data.length > 100 ||
        typeof page.has_more !== "boolean"
      )
        throw new Error();
      const ids = new Set<string>();
      for (const file of page.data) {
        if (
          !file ||
          typeof file.id !== "string" ||
          !/^file[-_][A-Za-z0-9_-]{1,160}$/.test(file.id) ||
          ids.has(file.id) ||
          !["in_progress", "completed", "failed", "cancelled"].includes(
            file.status,
          )
        )
          throw new Error();
        ids.add(file.id);
      }
      if (
        page.has_more &&
        (!page.data.length || page.last_id !== page.data.at(-1)!.id)
      )
        throw new Error();
      return page;
    } catch (error) {
      if (error instanceof BackgroundFailure) throw error;
      throw new BackgroundFailure("provider_response");
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
