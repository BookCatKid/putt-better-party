/** Bounded FIFO concurrency, with a shared minimum interval between starts. */
export class PacedRequestQueue {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private startQueue = Promise.resolve();
  private lastStartedAt = -Infinity;

  constructor(
    private readonly maximumActive: number,
    private readonly intervalMs: number,
  ) {}

  async run<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (this.active >= this.maximumActive) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active++;
    }
    try {
      // Serialize starts, not responses. A slow response cannot block all
      // independent reads, and a fast response cannot bypass the pacing.
      const start = this.startQueue.then(async () => {
        let remaining = this.intervalMs - (performance.now() - this.lastStartedAt);
        while (remaining > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, Math.ceil(remaining)));
          remaining = this.intervalMs - (performance.now() - this.lastStartedAt);
        }
        this.lastStartedAt = performance.now();
      });
      this.startQueue = start;
      await start;
      return await operation();
    } finally {
      const next = this.waiters.shift();
      if (next) {
        next();
      } else {
        this.active--;
      }
    }
  }
}
