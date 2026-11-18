import { expect, test } from 'bun:test';
import { generatePlaylist, parseFilters, PlaylistJobs } from '../src/playlist-generator.js';

const filters = (overrides = {}) =>
  parseFilters({
    search: '',
    daily: 'any',
    sort: 'new',
    mode: 'replace',
    ranges: {},
    ...overrides,
  });
const candidates = [
  { id: 'one', title: 'One', ratingAvg: 4.5, ratingCount: 10, scheduledDay: null },
  { id: 'two', title: 'Two', ratingAvg: 3, ratingCount: 100 },
  { id: 'three', title: 'Three', ratingAvg: 4.8, ratingCount: 15, scheduledDay: 4 },
  { id: 'four', title: 'Four', ratingAvg: 4.2, ratingCount: 10 },
  { id: 'five', title: 'Five', ratingAvg: 4.7, ratingCount: 10, scheduledDay: 99 },
  { id: 'six', title: 'Six', ratingAvg: null, ratingCount: 0 },
];
const stats = { one: 4.5, three: 5, four: null, five: 7 };
const pars = { one: 3, three: 4, five: 2 };
function dependencies() {
  const calls = { browse: [], stats: [], specification: [], progress: [] };
  return {
    calls,
    deps: {
      browse: async (options) => {
        calls.browse.push(options);
        const data = options.daily
          ? candidates.filter((hole) => typeof hole.scheduledDay === 'number')
          : candidates;
        const offset = options.offset ?? 0;
        return {
          holes: data.slice(offset, offset + 2),
          total: data.length,
          nextOffset: offset + 2 < data.length ? offset + 2 : null,
        };
      },
      stats: async (id) => {
        calls.stats.push(id);
        return { avgStrokes: stats[id] ?? null };
      },
      specification: async (id) => {
        calls.specification.push(id);
        return { par: pars[id] ?? 3 };
      },
      currentDay: () => 10,
      allowed: () => true,
      progress: (progress) => calls.progress.push(progress),
    },
  };
}

test('combine all bounds across every page; exclude missing statistics and past dailies; only request necessary data', async () => {
  const { calls, deps } = dependencies();
  const result = await generatePlaylist(
    filters({
      daily: 'exclude',
      ranges: {
        rating: { min: 4 },
        ratings: { min: 5 },
        average: { min: 4, max: 6 },
        par: { min: 2, max: 4 },
        overPar: { max: 2 },
      },
    }),
    deps,
  );
  expect(result.map((hole) => hole.id)).toEqual(['one']);
  expect(calls.stats).toEqual(['one', 'four', 'five']);
  expect(calls.specification).toEqual(['one']);
  expect(calls.progress.at(-1)).toEqual({ scanned: 6, total: 6, matched: 1 });
});
test('all matching courses remain in catalog order without fetching unnecessary details', async () => {
  const { calls, deps } = dependencies();
  expect((await generatePlaylist(filters(), deps)).map((hole) => hole.id)).toEqual(
    candidates.map((hole) => hole.id),
  );
  expect(calls.stats).toEqual([]);
  expect(calls.specification).toEqual([]);
  expect((await generatePlaylist(filters({ daily: 'only' }), deps)).map((hole) => hole.id)).toEqual(
    ['three'],
  );
});
test('reject invalid bounds, malformed filters and partial pagination instead of silently truncating', async () => {
  expect(() => filters({ ranges: { rating: { min: 6 } } })).toThrow();
  expect(() => filters({ ranges: { par: { min: 5, max: 1 } } })).toThrow();
  expect(() => filters({ ranges: { unknown: { min: 0 } } })).toThrow();
  expect(() => filters({ daily: 'invalid' })).toThrow();
  const { deps } = dependencies();
  await expect(
    generatePlaylist(filters(), {
      ...deps,
      browse: async () => ({ holes: [], total: 5, nextOffset: null }),
    }),
  ).rejects.toThrow('changed');
  await expect(
    generatePlaylist(filters(), {
      ...deps,
      browse: async () => ({ holes: [], total: 10001, nextOffset: null }),
    }),
  ).rejects.toThrow('range');
});
test('cancelled or failed jobs never overwrite an existing playlist, and all matches apply atomically', async () => {
  const { deps } = dependencies();
  const jobs = new PlaylistJobs();
  const applied = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  jobs.start(
    'ONE',
    filters(),
    {
      ...deps,
      browse: async (options) => {
        await gate;
        return deps.browse(options);
      },
    },
    (holes) => applied.push(holes),
  );
  expect(() => jobs.start('TWO', filters(), deps, () => {})).toThrow('already');
  expect(jobs.cancel('ONE').status).toBe('cancelled');
  release();
  await Bun.sleep(0);
  expect(applied).toEqual([]);
  jobs.start('TWO', filters(), deps, (holes) => applied.push(holes));
  await Bun.sleep(0);
  expect(jobs.get('TWO').status).toBe('complete');
  expect(applied[0]).toHaveLength(6);
  expect(jobs.get('TWO').progress.matched).toBe(6);
  jobs.start(
    'THREE',
    filters(),
    {
      ...deps,
      browse: async () => {
        throw Error('Network unavailable');
      },
    },
    (holes) => applied.push(holes),
  );
  await Bun.sleep(0);
  expect(jobs.get('THREE').status).toBe('failed');
  expect(applied).toHaveLength(1);
});

test('maximum courses limits the full filtered pool after ordering, including shuffled results from later pages', async () => {
  const { calls, deps } = dependencies();
  const limited = filters({ ranges: { rating: { min: 4, max: 5 } }, maxCourses: 2 });
  expect((await generatePlaylist(limited, deps)).map((hole) => hole.id)).toEqual(['one', 'three']);
  calls.browse.length = 0;
  const random = Math.random;
  try {
    Math.random = () => 0;
    const shuffled = await generatePlaylist({ ...limited, sort: 'shuffle' }, deps);
    expect(shuffled.map((hole) => hole.id)).toEqual(['three', 'four']);
    expect(calls.browse.map((page) => page.offset)).toEqual([0, 2, 4]);
    expect(calls.progress.at(-1).matched).toBe(4);
  } finally {
    Math.random = random;
  }
  expect(await generatePlaylist({ ...limited, maxCourses: 10 }, deps)).toHaveLength(4);
  expect(
    (
      await generatePlaylist(
        { ...limited, mode: 'append' },
        { ...deps, excludeIds: new Set(['one', 'three']) },
      )
    ).map((hole) => hole.id),
  ).toEqual(['four', 'five']);
  for (const invalid of [0, -1, 1.5, 10001, '10', null]) {
    expect(() => filters({ maxCourses: invalid })).toThrow('Maximum courses');
  }
});
