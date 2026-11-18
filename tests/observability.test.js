import { test, expect } from 'bun:test';
import { PacedRequestQueue } from '../src/upstream/request-queue.js';

/**
 * The queue's health counters.
 *
 * These numbers are what an operator reads to decide whether upstream is the
 * problem, so a counter that means something slightly different from its name is
 * worse than no counter: a failure folded into a plausible average hides exactly
 * the condition being looked for.
 */

test('no data reads as no data rather than instant', () => {
  const queue = new PacedRequestQueue(2, 1);
  // A zero average would be indistinguishable from sub-millisecond responses.
  expect(queue.metrics().averageLatencyMs).toBe(null);
  expect(queue.metrics().started).toBe(0);
  expect(queue.metrics().failed).toBe(0);
});

test('a successful request counts once and contributes its latency', async () => {
  const queue = new PacedRequestQueue(2, 1);
  await queue.run(async () => 'ok');
  const metrics = queue.metrics();
  expect(metrics.started).toBe(1);
  expect(metrics.failed).toBe(0);
  expect(typeof metrics.averageLatencyMs).toBe('number');
});

test('a failing request is counted as both started and failed', async () => {
  const queue = new PacedRequestQueue(2, 1);
  await expect(
    queue.run(async () => {
      throw new Error('upstream down');
    }),
  ).rejects.toThrow('upstream down');
  const metrics = queue.metrics();
  // It started, so it belongs in the latency average; it failed, so it is
  // counted separately. Losing it from both would understate the problem.
  expect(metrics.started).toBe(1);
  expect(metrics.failed).toBe(1);
  // A failure does not stop the queue admitting the next request.
  expect(await queue.run(async () => 'next')).toBe('next');
  expect(queue.metrics().started).toBe(2);
});

test('the slowest duration is the maximum, not the most recent', async () => {
  const queue = new PacedRequestQueue(2, 1);
  await queue.run(async () => {});
  await queue.run(() => new Promise((resolve) => setTimeout(resolve, 60)));
  await queue.run(async () => {});
  const metrics = queue.metrics();
  // The last request was fast; the reported worst case must still be the slow one.
  expect(metrics.slowestLatencyMs).toBeGreaterThanOrEqual(55);
  expect(metrics.started).toBe(3);
});

test('running and waiting report what is actually in flight', async () => {
  const queue = new PacedRequestQueue(1, 1, 4);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const first = queue.run(async () => {
    await held;
    return 'first';
  });
  // Give the first request its slot, then queue more behind it.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const waiting = [queue.run(async () => 'b'), queue.run(async () => 'c')];
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(queue.metrics().running).toBe(1);
  expect(queue.metrics().waiting).toBe(2);
  // A health read must not disturb the queue it is describing.
  expect(queue.waiting).toBe(2);
  release();
  await first;
  await Promise.all(waiting);
  expect(queue.metrics().running).toBe(0);
  expect(queue.metrics().waiting).toBe(0);
});

test('the reported version is the manifest version, not a second copy', async () => {
  const manifest = await Bun.file(new URL('../package.json', import.meta.url)).json();
  const { VERSION } = await import('../src/version.js');
  // A hard-coded release string in source drifts from the manifest the moment
  // someone bumps one and not the other, so the two are kept identical by
  // construction and this asserts the construction rather than a value.
  expect(VERSION).toBe(manifest.version);
  expect(typeof VERSION).toBe('string');
  expect(VERSION.length).toBeGreaterThan(0);
});
