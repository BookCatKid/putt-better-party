/**
 * Bounded FIFO concurrency, with a shared minimum interval between starts.
 *
 * The bound is not only on how many requests run at once but on how many may be
 * waiting. Waiting is the cheap-looking half and therefore the risk: a caller
 * that keeps asking while the upstream is slow would otherwise grow the queue
 * without limit, holding a closure and a promise for each request, and the
 * memory would stay claimed long after the callers gave up. A request that
 * cannot be admitted is refused instead, which the caller can report to its own
 * client rather than leaving it waiting for a slot that may never come.
 */
export class PacedRequestQueue {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private startQueue = Promise.resolve();
  private lastStartedAt = -Infinity;

  constructor(
    private readonly maximumActive: number,
    private readonly intervalMs: number,
    private readonly maximumWaiting = 64,
  ) {}

  /** Requests queued and not yet started, for a health or metrics read. */
  get waiting(): number {
    return this.waiters.length;
  }

  async run<Value>(operation: () => Promise<Value>): Promise<Value> {
    if (this.active >= this.maximumActive) {
      if (this.waiters.length >= this.maximumWaiting) {
        throw new Error('Too many catalog requests are already waiting');
      }
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
