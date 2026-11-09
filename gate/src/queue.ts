import { GateError } from "./errors.js";
interface Job {
  start: () => void;
  cancel: () => void;
  controller: AbortController;
}
export class BoundedQueue {
  private running: Job | undefined;
  private readonly waiting: Job[] = [];
  private closed = false;
  private readonly idleWaiters: Array<() => void> = [];
  constructor(
    private readonly maxPending = 16,
    private readonly deadlineMs = 120000,
  ) {}
  run<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    outer?: AbortSignal,
  ): Promise<T> {
    if (this.closed || (this.running && this.waiting.length >= this.maxPending))
      return Promise.reject(new GateError("BUSY", "Server busy"));
    if (outer?.aborted)
      return Promise.reject(new GateError("CANCELLED", "Request cancelled"));
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      let started = false;
      const cleanup = () => {
        clearTimeout(timer);
        outer?.removeEventListener("abort", cancel);
      };
      const cancel = () => {
        controller.abort();
        if (!settled) {
          settled = true;
          reject(new GateError("CANCELLED", "Request cancelled or timed out"));
          cleanup();
        }
        if (!started) {
          const index = this.waiting.indexOf(job);
          if (index >= 0) this.waiting.splice(index, 1);
          this.notifyIdle();
        }
      };
      const timer = setTimeout(cancel, this.deadlineMs);
      const job: Job = {
        controller,
        cancel,
        start: () => {
          started = true;
          this.running = job;
          Promise.resolve()
            .then(() => fn(controller.signal))
            .then(
              (value) => {
                if (!settled) {
                  settled = true;
                  resolve(value);
                }
              },
              (error) => {
                if (!settled) {
                  settled = true;
                  reject(error);
                }
              },
            )
            .finally(() => {
              cleanup();
              this.running = undefined;
              const next = this.waiting.shift();
              if (next) next.start();
              else this.notifyIdle();
            });
        },
      };
      outer?.addEventListener("abort", cancel, { once: true });
      if (this.running) this.waiting.push(job);
      else job.start();
    });
  }
  private notifyIdle(): void {
    if (!this.running && !this.waiting.length)
      this.idleWaiters.splice(0).forEach((resolve) => resolve());
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const job of [...this.waiting]) job.cancel();
    this.running?.cancel();
    if (this.running)
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }
}
