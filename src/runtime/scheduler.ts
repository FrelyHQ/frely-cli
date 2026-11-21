type Mode = "read" | "write";

type Job<T> = {
  mode: Mode;
  work: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

export class FairRwScheduler {
  private activeReaders = 0;
  private writer = false;
  private readonly queue: Job<unknown>[] = [];

  constructor(private readonly maxReaders = 4, private readonly beforeWork: () => void | Promise<void> = () => undefined) {
    if (!Number.isSafeInteger(maxReaders) || maxReaders < 1 || maxReaders > 64) {
      throw new Error("maxReaders must be an integer between 1 and 64.");
    }
  }

  /** A job still waiting in the queue when `signal` aborts is dropped and rejected; a job that already started is not interrupted. */
  read<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue("read", work, signal);
  }

  write<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.enqueue("write", work, signal);
  }

  private enqueue<T>(mode: Mode, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
      const job: Job<unknown> = { mode, work, resolve: resolve as (value: unknown) => void, reject };
      if (signal) {
        const onAbort = () => {
          const index = this.queue.indexOf(job);
          if (index < 0) return;
          this.queue.splice(index, 1);
          reject(signal.reason ?? new Error("aborted"));
          this.drain();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        job.work = async () => {
          signal.removeEventListener("abort", onAbort);
          return work();
        };
      }
      this.queue.push(job);
      this.drain();
    });
  }

  private drain(): void {
    if (this.writer) return;
    const first = this.queue[0];
    if (!first) return;

    if (first.mode === "write") {
      if (this.activeReaders > 0) return;
      this.writer = true;
      this.queue.shift();
      void Promise.resolve().then(() => this.beforeWork()).then(first.work).then(first.resolve, first.reject).finally(() => {
        this.writer = false;
        this.drain();
      });
      return;
    }

    while (!this.writer && this.activeReaders < this.maxReaders && this.queue[0]?.mode === "read") {
      const job = this.queue.shift()!;
      this.activeReaders += 1;
      void Promise.resolve().then(() => this.beforeWork()).then(job.work).then(job.resolve, job.reject).finally(() => {
        this.activeReaders -= 1;
        this.drain();
      });
    }
  }
}
