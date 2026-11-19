import { test, expect, mock, afterEach } from 'bun:test';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const adapterPath = path.join(root, 'src/upstream/client-adapter.ts');

/**
 * Catalog resilience: the edges of the upstream browse path that the detail
 * tests don't reach — pagination caching, failure non-stickiness, 429/500
 * propagation, cache bounds and no automatic retry.
 *
 * Mock discipline follows upstream-limits.test.js: the adapter module is
 * replaced process-wide by other files too, so this file installs its own
 * delegating mock and imports its own module instance by query string.
 */

const realAdapter = await import(adapterPath + '?catalog-resilience-real');
let testBehavior = null;
let invocations = 0;
mock.module(adapterPath, () => ({
  ...realAdapter,
  invokePublicFunction: (identifier, method, data, transport) => {
    invocations += 1;
    return testBehavior
      ? testBehavior(identifier, method, data, transport)
      : realAdapter.invokePublicFunction(identifier, method, data, transport);
  },
}));
const { browse, catalogMetrics } = await import(
  path.join(root, 'src/upstream/catalog.ts') + '?catalog-resilience'
);

afterEach(() => {
  testBehavior = null;
});

const page = (offset) => ({
  holes: [
    {
      id: `page-${offset}-hole`,
      title: `Hole at ${offset}`,
      author: 'author',
      createdAt: 1,
    },
  ],
  total: 100,
  offset,
  nextOffset: offset + 24,
});

async function rejection(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

test('a failed page is not cached — the next identical browse asks upstream again', async () => {
  // The failure path removes its own cache entry, so a 429/500/wobble cannot
  // pin a dead page into the cache for the TTL's whole lifetime.
  testBehavior = () => {
    throw new Error('Public catalog unavailable (HTTP 429)');
  };
  const before = invocations;
  expect(await rejection(browse({ fresh: true }))).toBeInstanceOf(Error);
  expect(await rejection(browse({}))).toBeInstanceOf(Error);
  expect(invocations - before).toBe(2);

  testBehavior = (identifier, method, data) => page(data.offset ?? 0);
  const result = await browse({});
  expect(result.holes).toHaveLength(1);
  expect(invocations - before).toBe(3);
});

test('there is no automatic retry — a rate limit costs exactly one request', async () => {
  // Retrying a 429 behind the caller's back would multiply upstream load at
  // the worst time; the caller decides whether and when to ask again.
  testBehavior = () => {
    throw new Error('Public catalog unavailable (HTTP 429)');
  };
  const before = invocations;
  await rejection(browse({ fresh: true, sort: 'top' }));
  expect(invocations - before).toBe(1);
});

test('pagination is cached by its own key: identical options share one request, distinct pages do not', async () => {
  testBehavior = (identifier, method, data) => page(data.offset ?? 0);
  const before = invocations;
  // Same key twice: the second answer is the cached promise, not a re-fetch.
  const first = await browse({ offset: 48, sort: 'new', fresh: true });
  const second = await browse({ offset: 48, sort: 'new' });
  expect(first).toEqual(second);
  // A different page mutates the key, not the cache entry.
  const third = await browse({ offset: 72, sort: 'new' });
  expect(third.offset).toBe(72);
  expect(invocations - before).toBe(2);
  // And `fresh` deliberately bypasses the cache for a forced re-list.
  await browse({ offset: 48, sort: 'new', fresh: true });
  expect(invocations - before).toBe(3);
});

test('the page cache stays bounded under pagination churn', async () => {
  // 128 distinct option keys is the documented bound; a crawler flipping
  // through hundreds of offsets must evict, not grow.
  testBehavior = (identifier, method, data) => page(data.offset ?? 0);
  for (let index = 0; index < 200; index += 1) {
    await browse({ offset: index * 24, search: `q${index}`, fresh: true });
  }
  expect(catalogMetrics().catalogPages).toBeLessThanOrEqual(128);
});

test('a malformed page shape is refused, not cached', async () => {
  testBehavior = () => ({ holes: 'not-an-array' });
  const error = await rejection(browse({ fresh: true, author: 'x' }));
  expect(String(error?.message)).toContain('Unexpected public catalog response');
  // The refusal removes the cache entry too: a bad page must not linger.
  const before = invocations;
  testBehavior = (identifier, method, data) => page(0);
  await browse({ author: 'x' });
  expect(invocations - before).toBe(1);
});
