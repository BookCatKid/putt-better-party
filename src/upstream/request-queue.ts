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
  /**
   * Lifetime counters for the health report. They are deliberately coarse: a
   * count and a slowest-case duration answer "is upstream healthy" without
   * carrying per-request detail that would grow with traffic.
   */
  private started = 0;
  private failed = 0;
  private totalLatencyMs = 0;
  private slowestLatencyMs = 0;

  constructor(
    private readonly maximumActive: number,
    private readonly intervalMs: number,
    private readonly maximumWaiting = 64,
  ) {}

  /** Requests queued and not yet started, for a health or metrics read. */
  get waiting(): number {
    return this.waiters.length;
  }

  /** Running requests, for a health or metrics read. */
  get running(): number {
    return this.active;
  }

  /**
   * What upstream access has looked like, as counters rather than samples.
   * `average` is `null` until at least one request has finished, because a zero
   * would read as "instant" rather than "no data".
   */
  metrics() {
    return {
      running: this.active,
      waiting: this.waiters.length,
      started: this.started,
      failed: this.failed,
      averageLatencyMs: this.started ? Math.round(this.totalLatencyMs / this.started) : null,
      slowestLatencyMs: this.slowestLatencyMs,
    };
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
      // Latency is measured around the operation alone, not around the wait for a
      // slot: the wait is a consequence of our own pacing, and mixing the two
      // would hide a slow upstream behind a healthy-looking average.
      const operationStarted = performance.now();
      this.started += 1;
      let succeeded = false;
      try {
        const result = await operation();
        succeeded = true;
        return result;
      } finally {
        const elapsed = performance.now() - operationStarted;
        this.totalLatencyMs += elapsed;
        if (elapsed > this.slowestLatencyMs) {
          this.slowestLatencyMs = Math.round(elapsed);
        }
        if (!succeeded) {
          // A failed request still cost its latency, so it stays in the average;
          // it is counted separately so a run of failures is visible rather than
          // hidden behind a plausible-looking duration.
          this.failed += 1;
        }
      }
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
