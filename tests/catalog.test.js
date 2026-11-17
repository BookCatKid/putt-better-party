import { test, expect, mock } from 'bun:test';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const adapterPath = path.join(root, 'src/upstream/client-adapter.ts');

/**
 * Live-only course sources.
 *
 * Every playable course has to come from a validated public detail response.
 * These regressions replace the original client's network transport — not the
 * parsing boundary — so the real `detail()` and `parsePublicCourseDetail()` run
 * against controllable answers, and prove that nothing else (a restored room, a
 * cached listing, a file on disk) can supply playable geometry on its own.
 */

/** A minimal course the original validator accepts. */
function courseSpec(overrides = {}) {
  return {
    runtimeVersion: 2,
    id: 'editor-probe',
    name: 'Probe',
    par: 2,
    pieces: [
      { piece: 'start', x: 0, z: 3, y: 0 },
      { piece: 'ramp-high', x: 4, z: -1, y: 0 },
    ],
    ball: { x: 0, z: 2.8, y: 0 },
    cup: { x: 0, z: -6.5, y: 0 },
    theme: 'sunset',
    ...overrides,
  };
}

/** Replaced per test; the adapter mock dispatches POST to `detail`. */
const upstream = {
  requests: { list: [], detail: [] },
  detailAnswer: async (id) => ({ id, public: false }),
  listAnswer: async () => ({ holes: [], total: 0, offset: 0, nextOffset: null }),
};

const realAdapter = await import(adapterPath);
mock.module(adapterPath, () => ({
  ...realAdapter,
  // The original public server function serializer is the only network seam;
  // swapping it keeps the real request parsing and validation in the path.
  invokePublicFunction: (identifier, method, data) => {
    if (method === 'POST') {
      const id = data.id;
      upstream.requests.detail.push(id);
      return upstream.detailAnswer(id);
    }
    upstream.requests.list.push(data);
    return upstream.listAnswer(data);
  },
}));

/** Import a catalog instance bound to the answers configured for this test. */
async function catalogWith({ detail: detailAnswer, list: listAnswer } = {}) {
  upstream.requests.detail.length = 0;
  upstream.requests.list.length = 0;
  upstream.detailAnswer = detailAnswer ?? (async (id) => ({ id, public: false }));
  upstream.listAnswer =
    listAnswer ?? (async () => ({ holes: [], total: 0, offset: 0, nextOffset: null }));
  // The module registry caches the first import, so each test gets its own
  // query string for a catalog with an empty, isolated index.
  const stamp = `${Date.now()}-${Math.random()}`;
  return import(path.join(root, 'src/catalog.ts') + '?probe=' + stamp);
}

const pickedConfig = (selectedHoleIds) => ({
  mapSource: 'picked',
  selectedHoleIds,
  holes: selectedHoleIds.length,
  timerMs: 60000,
  elimination: false,
  maxPlayers: 8,
  locked: false,
  excludeDaily: false,
  randomHoles: 1,
});

test('a playable course is only ever the validated public detail response', async () => {
  const catalog = await catalogWith({
    detail: async (id) => ({
      id,
      public: true,
      title: 'Detail title',
      author: 'Maker',
      spec: courseSpec(),
    }),
  });
  const course = await catalog.fetchPublicMap('public-1', { saved: true });

  // The geometry came from the detail call, and the served record is built from
  // that answer rather than from anything remembered locally.
  expect(upstream.requests.detail).toEqual(['public-1']);
  expect(course.spec.pieces).toHaveLength(2);
  expect(course.par).toBe(2);
  expect(course.id).toBe('public-1');
  expect(course.title).toBe('Detail title');
  expect(catalog.courseIndex.get('public-1')?.spec?.pieces).toHaveLength(2);

  // A second start re-asks upstream instead of trusting the first answer.
  await catalog.fetchPublicMap('public-1', { saved: true });
  expect(upstream.requests.detail).toEqual(['public-1', 'public-1']);
});

test('a non-public, mismatched or geometry-free detail is refused outright', async () => {
  const answers = new Map([
    ['private-1', { id: 'private-1', public: false, title: 'Hidden', spec: courseSpec() }],
    ['other-1', { id: 'someone-else', public: true, title: 'Wrong', spec: courseSpec() }],
    ['empty-1', { id: 'empty-1', public: true, title: 'No geometry' }],
    ['list-1', ['not', 'a', 'record']],
    ['untitled-1', { id: 'untitled-1', public: true, spec: courseSpec() }],
  ]);
  const catalog = await catalogWith({ detail: async (id) => answers.get(id) });

  for (const id of answers.keys()) {
    // Bun's rejects matcher inspects an already-settled promise, so the refusal
    // is captured directly instead.
    let refusal = null;
    try {
      await catalog.fetchPublicMap(id, { saved: true });
    } catch (error) {
      refusal = error;
    }
    expect(refusal?.message).toBeTruthy();
    // A refusal leaves nothing behind: no course may be served for an id whose
    // only answer was rejected.
    expect(catalog.courseIndex.get(id)?.spec).toBeUndefined();
  }
});

test('the public detail boundary rejects anything upstream does not vouch for', async () => {
  const { parsePublicCourseDetail } = await import(path.join(root, 'src/upstream.ts'));
  const listed = { title: 'Listed title', author: 'Maker' };
  const accepted = parsePublicCourseDetail(
    'public-1',
    { id: 'public-1', public: true, spec: courseSpec() },
    listed,
  );
  // Listing metadata fills the gaps, and the detail response wins where it
  // speaks, so a renamed course is served under its current name.
  expect(accepted).toEqual({
    id: 'public-1',
    title: 'Listed title',
    author: 'Maker',
    spec: courseSpec(),
  });
  expect(
    parsePublicCourseDetail(
      'public-1',
      { id: 'public-1', public: true, title: 'Renamed', author: 'Someone', spec: courseSpec() },
      listed,
    ),
  ).toMatchObject({ title: 'Renamed', author: 'Someone' });

  const refusals = [
    [{ id: 'public-1', public: false, spec: courseSpec() }, listed],
    [{ id: 'public-1', spec: courseSpec() }, listed],
    [{ id: 'other', public: true, spec: courseSpec() }, listed],
    [{ id: 'public-1', public: true, title: 'No geometry' }, listed],
    ['nope', listed],
    [{ id: 'public-1', public: true, spec: courseSpec() }, {}],
  ];
  for (const [result, metadata] of refusals) {
    expect(() => parsePublicCourseDetail('public-1', result, metadata)).toThrow();
  }
});

test('a failed detail fetch never falls back to anything already known', async () => {
  const catalog = await catalogWith({
    detail: async () => {
      throw new Error('Public catalog unavailable (HTTP 503)');
    },
  });

  // The listing is allowed and records metadata only.
  const page = await catalog.prepareMatch(pickedConfig([]), []);
  expect(page.ids).toEqual([]);
  expect(catalog.courseIndex.has('public-1')).toBe(false);

  // A failing detail fetch is a failure, not a reason to reuse a stored copy.
  let refusal = null;
  try {
    await catalog.fetchPublicMap('public-1', { saved: true });
  } catch (error) {
    refusal = error;
  }
  expect(refusal?.message).toContain('Public catalog unavailable');
  expect(catalog.courseIndex.get('public-1')).toBeUndefined();
});

test('a restored room registers metadata only, never playable geometry', async () => {
  const catalog = await catalogWith();
  // Recovery registers what a restart needs: the id/title of a selected course.
  // This writer refuses to replace a course a live retrieval validated.
  catalog.courseIndex.set('restored-1', { id: 'restored-1', title: 'Restored', par: 3 });
  expect(catalog.courseIndex.get('restored-1')).toEqual({ id: 'restored-1', title: 'Restored' });

  // A restarted room starts through the same preparation path as a fresh one,
  // so missing geometry is fetched rather than invented.
  const { Room } = await import(path.join(root, 'src/room.ts'));
  const socket = () => ({
    data: {},
    frames: [],
    send(serialized) {
      this.frames.push(JSON.parse(serialized));
    },
    close() {},
  });
  const room = new Room('ABCDE', catalog.courseIndex, {
    countdown: 5,
    results: 5,
    prepareMatch: catalog.prepareMatch,
  });
  const ws = socket();
  room.handle(ws, { t: 'join', ...room.issue('Host'), protocol: 2, host: room.hostToken });
  room.handle(ws, { t: 'config', config: pickedConfig(['restored-1']) });
  room.handle(ws, { t: 'start' });
  await Bun.sleep(20);

  // Upstream has no such course, so the round never starts and the host is told
  // why. Nothing was played from the remembered title.
  expect(upstream.requests.detail).toEqual(['restored-1']);
  expect(room.phase).toBe('lobby');
  expect(room.specs).toEqual([]);
  expect(ws.frames.some((frame) => frame.t === 'error' && frame.code === 'map-load-failed')).toBe(
    true,
  );
  room.dispose();
});

test('a match fills its specifications only through the public detail call', async () => {
  const catalog = await catalogWith({
    detail: async (id) =>
      id === 'public-2'
        ? { id, public: true, title: 'Second', spec: courseSpec({ par: 4 }) }
        : { id, public: true, title: 'Listed', spec: courseSpec() },
  });

  // A manual playlist retrieves its first hole up front and the rest lazily.
  const prepared = await catalog.prepareMatch(pickedConfig(['public-1', 'public-2']), []);
  expect(upstream.requests.detail).toEqual(['public-1']);
  expect(prepared.ids).toEqual(['public-1', 'public-2']);
  expect(prepared.specs).toHaveLength(1);

  // The next hole is retrieved through the same validated boundary and only
  // then becomes playable.
  await catalog.fetchPublicMap('public-2', { saved: true });
  expect(upstream.requests.detail).toEqual(['public-1', 'public-2']);
  expect(catalog.courseIndex.get('public-2')?.spec?.par).toBe(4);
});

test('a random match resolves every hole through the same boundary', async () => {
  const catalog = await catalogWith({
    list: async () => ({
      holes: [
        { id: 'random-1', title: 'First random' },
        { id: 'random-2', title: 'Second random' },
      ],
      total: 2,
      offset: 0,
      nextOffset: null,
    }),
    detail: async (id) => ({ id, public: true, title: 'Random', spec: courseSpec() }),
  });

  const prepared = await catalog.prepareMatch(
    { ...pickedConfig(['random-1', 'random-2']), mapSource: 'random', holes: 2, randomHoles: 2 },
    [],
  );
  expect(prepared.ids).toHaveLength(2);
  expect(new Set(prepared.ids)).toEqual(new Set(['random-1', 'random-2']));
  // Random holes are bounded, so they are fetched together and every one of
  // them came from a detail answer.
  expect(prepared.specs).toHaveLength(2);
  expect(upstream.requests.detail).toHaveLength(2);
});
