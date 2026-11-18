import { test, expect, mock } from 'bun:test';
import path from 'node:path';

const root = path.resolve(import.meta.dir, '..');
const adapterPath = path.join(root, 'src/upstream/client-adapter.ts');

/**
 * Live-only course sources.
 *
 * Every playable course has to come from a validated public detail response.
 * The real detail parser, catalog and original pinned validator run against
 * controlled public responses. Only the network transport is replaced.
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

const originalAdapter = { ...(await import(adapterPath)) };
const validation = { requests: [], failure: null };

mock.module(adapterPath, () => ({
  ...originalAdapter,
  validateCourse(specification, title) {
    validation.requests.push({ specification, title });
    if (validation.failure) {
      throw validation.failure;
    }
    return originalAdapter.validateCourse(specification, title);
  },
  // Fake the network answers while preserving the original validator.
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
  validation.requests.length = 0;
  validation.failure = null;
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
  expect(validation.requests).toEqual([{ specification: courseSpec(), title: 'Detail title' }]);
  expect(course.spec.name).toBe('Detail title');
  expect(catalog.courseIndex.get('public-1')?.spec?.pieces).toHaveLength(2);

  // A second start re-asks upstream instead of trusting the first answer.
  await catalog.fetchPublicMap('public-1', { saved: true });
  expect(upstream.requests.detail).toEqual(['public-1', 'public-1']);
});

test('a validator rejection never registers playable geometry', async () => {
  const catalog = await catalogWith({
    detail: async (id) => ({ id, public: true, title: 'Invalid', spec: courseSpec() }),
  });
  validation.failure = new Error('Validator refused specification');
  try {
    await expect(catalog.fetchPublicMap('invalid-course', { saved: true })).rejects.toThrow(
      'Validator refused specification',
    );
    expect(validation.requests).toHaveLength(1);
    expect(catalog.courseIndex.has('invalid-course')).toBe(false);
  } finally {
    validation.failure = null;
  }
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

/**
 * Public course identity.
 *
 * A course has two identifiers: the catalog id that lists it and the id inside
 * its specification. They coincide for some courses and differ for most, and
 * the renderer, the readiness report and the room all see the second form. The
 * catalog is also mutable - a course can be renamed, re-saved into a new
 * revision, forked, or withdrawn - so identity has to survive re-asking without
 * letting a stale or foreign answer stand in for the course that was requested.
 */
test('a catalog id and the specification id inside it are separate identities', async () => {
  const catalog = await catalogWith({
    // Upstream knows the catalog id only; the specification id is not a course
    // of its own and answers with an empty envelope.
    detail: async (id) =>
      id === '44468fa2753b4cf6bb91901a7ab3959c'
        ? { id, public: true, title: 'Do it try it', spec: courseSpec({ id: 'editor-abc123' }) }
        : {},
  });
  const course = await catalog.fetchPublicMap('44468fa2753b4cf6bb91901a7ab3959c', { saved: true });

  // The course is keyed by the id it was requested with, and the specification
  // keeps the id it was authored with. Neither is rewritten into the other.
  expect(course.id).toBe('44468fa2753b4cf6bb91901a7ab3959c');
  expect(course.spec.id).toBe('editor-abc123');
  expect(catalog.courseIndex.has('44468fa2753b4cf6bb91901a7ab3959c')).toBe(true);
  // The specification id is not a catalog key: asking for it is a different
  // course request and upstream has no such public course.
  expect(catalog.courseIndex.has('editor-abc123')).toBe(false);
  let refusal = null;
  try {
    await catalog.fetchPublicMap('editor-abc123', { saved: true });
  } catch (error) {
    refusal = error;
  }
  expect(refusal?.message).toBe('Map is unavailable or not public');
});

test('an answer describing a different course is refused even when it is public', async () => {
  // A cache, a proxy or an upstream bug that returns the wrong course must not
  // silently replace the one that was asked for.
  const catalog = await catalogWith({
    detail: async (id) => ({
      id: 'a-different-course',
      public: true,
      title: 'Other',
      spec: courseSpec(),
    }),
  });
  let refusal = null;
  try {
    await catalog.fetchPublicMap('requested-course', { saved: true });
  } catch (error) {
    refusal = error;
  }
  expect(refusal?.message).toBe('Map is unavailable or not public');
  expect(catalog.courseIndex.has('requested-course')).toBe(false);
  expect(catalog.courseIndex.has('a-different-course')).toBe(false);
});

test('a non-public answer is refused whatever its status says', async () => {
  // The listing and the detail disagree on lifecycle status: pending and
  // approved courses are both publicly playable, so status is not the gate.
  // Visibility is, and only `public: true` grants it.
  for (const status of ['pending', 'approved', 'rejected', 'hidden']) {
    const catalog = await catalogWith({
      detail: async (id) => ({ id, status, public: false, title: 'Hidden', spec: courseSpec() }),
    });
    let refusal = null;
    try {
      await catalog.fetchPublicMap('hidden-course', { saved: true });
    } catch (error) {
      refusal = error;
    }
    expect(`${status}: ${refusal?.message}`).toBe(`${status}: Map is unavailable or not public`);
  }
  // A pending course that is public is playable: new courses start pending.
  const catalog = await catalogWith({
    detail: async (id) => ({
      id,
      status: 'pending',
      public: true,
      title: 'New',
      spec: courseSpec(),
    }),
  });
  const course = await catalog.fetchPublicMap('new-course', { saved: true });
  expect(course.title).toBe('New');
});

test('a renamed course is served under its current name, not a remembered one', async () => {
  let title = 'First name';
  const catalog = await catalogWith({
    detail: async (id) => ({ id, public: true, title, spec: courseSpec() }),
  });
  expect((await catalog.fetchPublicMap('renamed-course', { saved: true })).title).toBe(
    'First name',
  );
  title = 'Second name';
  const updated = await catalog.fetchPublicMap('renamed-course', { saved: true });
  expect(updated.title).toBe('Second name');
  // The listing cache follows the newest detail answer rather than pinning the
  // first one, so the playlist shows the name the course has now.
  expect(catalog.courseIndex.get('renamed-course')?.title).toBe('Second name');
});

test('a re-saved course yields the newest geometry, not the first copy', async () => {
  // Editing a course produces a new revision of the same public id. A match
  // must play the current revision, so nothing may short-circuit the fetch.
  let revision = 1;
  const catalog = await catalogWith({
    detail: async (id) => ({
      id,
      public: true,
      title: 'Revisited',
      spec: courseSpec({ par: revision === 1 ? 3 : 5 }),
    }),
  });
  expect((await catalog.fetchPublicMap('revised-course', { saved: true })).par).toBe(3);
  revision = 2;
  const current = await catalog.fetchPublicMap('revised-course', { saved: true });
  expect(current.par).toBe(5);
  expect(upstream.requests.detail).toEqual(['revised-course', 'revised-course']);
});

test('two courses may share a specification id without colliding', async () => {
  // Forking copies a course, and its specification may keep the original id.
  // Identity has to be the catalog id, or one fork would overwrite the other.
  const catalog = await catalogWith({
    detail: async (id) => ({
      id,
      public: true,
      title: id === 'fork-one' ? 'Original' : 'Fork',
      spec: courseSpec({ id: 'editor-shared', par: id === 'fork-one' ? 3 : 6 }),
    }),
  });
  const original = await catalog.fetchPublicMap('fork-one', { saved: true });
  const fork = await catalog.fetchPublicMap('fork-two', { saved: true });
  expect(original.spec.id).toBe('editor-shared');
  expect(fork.spec.id).toBe('editor-shared');
  expect(catalog.courseIndex.get('fork-one')?.par).toBe(3);
  expect(catalog.courseIndex.get('fork-two')?.par).toBe(6);
  expect(catalog.courseIndex.get('fork-one')?.title).toBe('Original');
  expect(catalog.courseIndex.get('fork-two')?.title).toBe('Fork');
});

test('a duplicate in a playlist keeps its position and is fetched once', async () => {
  // Duplicates are a supported manual playlist: the same course twice means the
  // same hole played twice. Loading has to preserve both positions while not
  // asking upstream for the same course twice in one preparation.
  const catalog = await catalogWith({
    detail: async (id) => ({ id, public: true, title: 'Twice', spec: courseSpec() }),
  });
  const duplicated = ['public-1', 'public-2', 'public-1'];
  const repeated = ['public-1', 'public-1', 'public-1'];
  // Import registers both courses before a playlist can name them, exactly as
  // the import endpoint does for a real saved playlist.
  await catalog.fetchPublicMap('public-1', { saved: true });
  await catalog.fetchPublicMap('public-2', { saved: true });
  upstream.requests.detail.length = 0;
  const prepared = await catalog.prepareMatch(pickedConfig(duplicated), []);
  expect(prepared.ids).toEqual(duplicated);
  // Only the first hole is loaded up front for a manual playlist.
  expect(upstream.requests.detail).toEqual(['public-1']);
  expect(prepared.specs).toHaveLength(1);

  // The room keeps every position, including the repeat.
  const { Room } = await import(path.join(root, 'src/room.ts'));
  const room = new Room('ABCDE', catalog.courseIndex, {
    countdown: 5,
    results: 5,
    prepareMatch: catalog.prepareMatch,
    loadMap: (id) => catalog.fetchPublicMap(id, { saved: true }),
  });
  const ws = {
    data: {},
    frames: [],
    send(serialized) {
      this.frames.push(JSON.parse(serialized));
    },
    close() {},
  };
  room.handle(ws, { t: 'join', ...room.issue('Host'), protocol: 2, host: room.hostToken });
  room.handle(ws, { t: 'config', config: pickedConfig(duplicated) });
  room.handle(ws, { t: 'start' });
  for (let attempt = 0; attempt < 200 && room.holeIds.length === 0; attempt++) {
    await Bun.sleep(5);
  }
  expect(room.holeIds).toEqual(duplicated);
  room.dispose();

  // An all-duplicate playlist is one course: however many times it repeats, the
  // start fetches it once and keeps every position.
  upstream.requests.detail.length = 0;
  const sameCourse = await catalog.prepareMatch(pickedConfig(repeated), []);
  expect(sameCourse.ids).toEqual(repeated);
  expect(upstream.requests.detail).toEqual(['public-1']);
  expect(sameCourse.specs).toHaveLength(1);
});

test('a blank or whitespace title is a missing identity, refused at the boundary', async () => {
  for (const title of ['', '   ', undefined]) {
    const catalog = await catalogWith({
      detail: async (id) => ({ id, public: true, title, spec: courseSpec() }),
    });
    let refusal = null;
    try {
      await catalog.fetchPublicMap('untitled-course', { saved: true });
    } catch (error) {
      refusal = error;
    }
    expect(`${JSON.stringify(title)}: ${refusal?.message}`).toBe(
      `${JSON.stringify(title)}: Missing public course title`,
    );
    expect(catalog.courseIndex.has('untitled-course')).toBe(false);
  }
});

test('random course details overlap but every specification retains its selected position', async () => {
  const gates = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()];
  const requested = [];
  const catalog = await catalogWith({
    list: async ({ daily }) =>
      daily
        ? { holes: [], total: 0, offset: 0, nextOffset: null }
        : {
            holes: [1, 2, 3].map((number) => ({
              id: 'parallel-' + number,
              title: 'Course ' + number,
            })),
            total: 3,
            offset: 0,
            nextOffset: null,
          },
    detail: async (id) => {
      const index = requested.push(id) - 1;
      await gates[index].promise;
      return { id, public: true, title: id, spec: courseSpec() };
    },
  });
  const preparation = catalog.prepareMatch(
    { ...pickedConfig([]), mapSource: 'random', holes: 3, randomHoles: 3, excludeDaily: true },
    [],
  );
  try {
    await Bun.sleep(0);
    expect(requested).toHaveLength(3);
    gates[2].resolve();
    gates[1].resolve();
    await Bun.sleep(0);
    // Later answers cannot publish a partial, out-of-order match.
    expect(catalog.courseIndex.has(requested[2])).toBe(false);
  } finally {
    gates.forEach((gate) => gate.resolve());
    await preparation;
  }
  const prepared = await preparation;
  expect(prepared.ids).toEqual(requested);
  expect(prepared.specs.map((specification) => specification.name)).toEqual(requested);
  expect(validation.requests).toHaveLength(3);
});

test('a random match still refuses a withdrawn course even when other details succeed', async () => {
  const requested = [];
  const catalog = await catalogWith({
    list: async ({ daily }) =>
      daily
        ? { holes: [], total: 0, offset: 0, nextOffset: null }
        : {
            holes: [1, 2].map((number) => ({
              id: 'withdrawn-test-' + number,
              title: 'Course ' + number,
            })),
            total: 2,
            offset: 0,
            nextOffset: null,
          },
    detail: async (id) => {
      requested.push(id);
      return { id, public: requested.length !== 1, title: id, spec: courseSpec() };
    },
  });
  await expect(
    catalog.prepareMatch(
      { ...pickedConfig([]), mapSource: 'random', holes: 2, randomHoles: 2, excludeDaily: true },
      [],
    ),
  ).rejects.toThrow('Map is unavailable or not public');
  expect(requested).toHaveLength(2);
  expect(requested.every((id) => !catalog.courseIndex.has(id))).toBe(true);
});
