import { expect, test } from 'bun:test';
import { PacedRequestQueue } from '../src/upstream/request-queue.js';

test('independent public reads start in order, overlap, and obey the shared pacing', async () => {
  const queue = new PacedRequestQueue(3, 20);
  const gate = Promise.withResolvers();
  const starts = [];
  let active = 0;
  let peak = 0;
  const requests = Array.from({ length: 6 }, (_unused, index) =>
    queue.run(async () => {
      starts.push({ index, at: performance.now() });
      active++;
      peak = Math.max(peak, active);
      try {
        await gate.promise;
        if (index === 1) {
          throw new Error('Upstream failure');
        }
        return index;
      } finally {
        active--;
      }
    }),
  );
  const settled = Promise.allSettled(requests);
  try {
    for (let attempt = 0; attempt < 100 && starts.length < 3; attempt++) {
      await Bun.sleep(5);
    }
    expect(starts.map(({ index }) => index)).toEqual([0, 1, 2]);
    expect(active).toBe(3);
  } finally {
    gate.resolve();
    await settled;
  }
  const results = await settled;
  expect(starts.map(({ index }) => index)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(peak).toBe(3);
  expect(results.map(({ status }) => status)).toEqual([
    'fulfilled',
    'rejected',
    'fulfilled',
    'fulfilled',
    'fulfilled',
    'fulfilled',
  ]);
  for (let index = 1; index < starts.length; index++) {
    expect(starts[index].at - starts[index - 1].at).toBeGreaterThanOrEqual(19);
  }
});
