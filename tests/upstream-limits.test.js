import { test, expect, mock, afterEach } from 'bun:test';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const adapterPath = path.join(root, 'src/upstream/client-adapter.ts');

/**
 * Memory and work bounds on the upstream adapter.
 *
 * The queues and both response caches were already bounded; what grew without limit
 * was the set of courses remembered from the catalogue, and what was duplicated was
 * two rooms fetching the same course detail at the same time.
 *
 * Isolation: catalog.test.js replaces this adapter module process-wide, and bun
 * does not guarantee which test file runs first, so a plain import of
 * src/upstream.js can come back bound to that file's fakes (the CI failure on
 * 4289465). This file therefore installs its own adapter - one that delegates to
 * the real implementation unless a test overrides it - and imports its own
 * upstream instance by query string, so its results depend on no other file.
 */
const realAdapter = await import(adapterPath + '?upstream-limits-real');
let testBehavior = null;
mock.module(adapterPath, () => ({
  ...realAdapter,
  invokePublicFunction: (identifier, method, data, transport) =>
    testBehavior
      ? testBehavior(identifier, method, data, transport)
      : realAdapter.invokePublicFunction(identifier, method, data, transport),
}));
const { detail, publicStats, rememberPublicMetadata, upstreamMetrics } = await import(
  path.join(root, 'src/upstream.ts') + '?upstream-limits'
);

afterEach(() => {
  testBehavior = null;
});

/** A valid public id shape, distinct per index. */
const id = (index) => 'course' + String(index).padStart(6, '0');

/**
 * Await a promise and return its rejection, or `null` if it resolved.
 *
 * Used instead of `expect(...).rejects` because the rejection here happens inside the
 * adapter before the matcher attaches, which Bun reports as an unhandled rejection
 * even though the assertion catches it.
 */
async function rejection(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

test('the remembered-course map is bounded and keeps the most recent', async () => {
  // More than the bound, in the order the catalogue would list them.
  for (let index = 0; index < 6000; index += 1) {
    rememberPublicMetadata(id(index), 'Course ' + index);
  }
  expect(upstreamMetrics().caches.knownCourses).toBeLessThanOrEqual(5000);

  // No network is needed to answer this: the check is the map itself, so a refusal
  // means the course was forgotten and a different failure means it was kept.
  testBehavior = () => {
    throw new Error('network disabled for this test');
  };
  expect(String((await rejection(publicStats(id(0))))?.message)).toContain(
    'Choose a hole from the public catalog first',
  );
  expect(String((await rejection(publicStats(id(5999))))?.message)).toContain(
    'network disabled for this test',
  );
});

test('two rooms asking for the same course share one upstream request', async () => {
  let calls = 0;
  testBehavior = () => {
    calls += 1;
    // A refusal is enough: the point is how many requests were made, and a rejected
    // response exercises the cleanup path as well as the success path.
    throw new Error('Public catalog unavailable (HTTP 500)');
  };
  const shared = id(424242);
  const results = await Promise.all([
    rejection(detail(shared, { saved: true })),
    rejection(detail(shared, { saved: true })),
  ]);
  expect(results.every((error) => error instanceof Error)).toBe(true);
  expect(calls).toBe(1);
});

test('a finished request does not leave a stale entry behind', async () => {
  // The coalescing map must empty itself, or a later request for the same course
  // would be answered from a settled promise for ever.
  let calls = 0;
  testBehavior = () => {
    calls += 1;
    throw new Error('Public catalog unavailable (HTTP 500)');
  };
  const repeated = id(777777);
  expect(await rejection(detail(repeated, { saved: true }))).toBeInstanceOf(Error);
  expect(await rejection(detail(repeated, { saved: true }))).toBeInstanceOf(Error);
  expect(calls).toBe(2);
});
