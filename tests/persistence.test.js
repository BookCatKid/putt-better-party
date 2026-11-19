import { test, expect } from 'bun:test';
import { RoomStore } from '../src/room-store.js';
import { Room } from '../src/room.js';
import { chooseRandom } from '../src/random-selection.js';
const mock = () => ({
  data: {},
  frames: [],
  send(serialized) {
    this.frames.push(JSON.parse(serialized));
  },
  close() {
    this.closed = true;
  },
});
function join(room, identity, host = false) {
  const ws = mock();
  room.handle(ws, { t: 'join', protocol: 2, ...identity, host: host ? room.hostToken : undefined });
  return ws;
}
test('room recovery retains credentials, playlist metadata, lock and random history, never map specs', () => {
  const store = new RoomStore(':memory:');
  const catalog = new Map([
    ['public1', { title: 'Test', spec: { id: 'private-engine-data', pieces: [1], par: 3 } }],
  ]);
  const room = new Room('ABCDE', catalog, { onChange: (changedRoom) => store.save(changedRoom) });
  const host = room.issue('Host');
  const guest = room.issue('Guest');
  const hostSocket = join(room, host, true);
  join(room, guest);
  room.handle(hostSocket, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['public1'], locked: true },
  });
  room.randomSeen = ['previous'];
  room.handle(hostSocket, { t: 'start' });
  const raw = store.db.query('SELECT payload FROM rooms WHERE code=?').get('ABCDE').payload;
  expect(raw).not.toContain('private-engine-data');
  expect(raw).not.toContain('pieces');
  room.dispose();
  const restoredCatalog = new Map();
  const newRoom = store.load(restoredCatalog).get('ABCDE');
  expect(newRoom.phase).toBe('lobby');
  expect(newRoom.recoveryNotice).toBe(true);
  expect(newRoom.hostToken).toBe(room.hostToken);
  expect(newRoom.hostUid).toBe(host.uid);
  expect(newRoom.config.selectedHoleIds).toEqual(['public1']);
  expect(newRoom.config.locked).toBe(true);
  expect(newRoom.randomSeen).toEqual(['previous']);
  expect(restoredCatalog.get('public1')).toEqual({ id: 'public1', title: 'Test' });
  expect(() => newRoom.issue('Unknown')).toThrow();
  expect(newRoom.issue('Host', host.uid, host.session)).toEqual(host);
  const ws = join(newRoom, host, true);
  expect(ws.frames.some((frame) => frame.t === 'hello' && frame.isHost)).toBe(true);
  expect(JSON.stringify(ws.frames)).not.toContain(guest.session);
  newRoom.dispose();
  store.close();
});
test('locked rooms admit returning identities but reject new ones; expiry removes saved rooms', () => {
  const store = new RoomStore(':memory:');
  const room = new Room('ABCDE', new Map(), { onChange: (changedRoom) => store.save(changedRoom) });
  const host = room.issue('Host');
  const guestSocket = room.issue('Guest');
  const hostSocket = join(room, host, true);
  const guest = join(room, guestSocket);
  room.handle(hostSocket, { t: 'config', config: { locked: true, maxPlayers: 2 } });
  expect(() => room.issue('Other')).toThrow();
  room.close(guest);
  expect(room.issue('Guest', guestSocket.uid, guestSocket.session)).toEqual(guestSocket);
  expect(join(room, guestSocket).frames.some((frame) => frame.t === 'hello')).toBe(true);
  room.lastActivity = Date.now() - 1800001;
  store.save(room);
  expect(store.load(new Map()).size).toBe(0);
  room.dispose();
  store.close();
});
test('random assignments avoid history until pool exhaustion, then wrap without repeating within a match', async () => {
  const holes = Array.from({ length: 26 }, (unused, index) => ({ id: 'hole' + index }));
  const calls = [];
  const browse = async ({ offset }) => {
    calls.push(offset);
    return { total: holes.length, holes: holes.slice(offset, offset + 24) };
  };
  const first = await chooseRandom({ browse, count: 9, seen: [], pick: () => 0 });
  const second = await chooseRandom({ browse, count: 9, seen: first.seen, pick: () => 0 });
  expect(first.ids.every((id) => !second.ids.includes(id))).toBe(true);
  expect(second.seen.length).toBe(18);
  const third = await chooseRandom({ browse, count: 9, seen: second.seen, pick: () => 0 });
  expect(third.ids.slice(0, 8).every((id) => !second.seen.includes(id))).toBe(true);
  expect(new Set(third.ids).size).toBe(9);
  // The rollover match played eight unseen courses plus one repeated course;
  // all nine count toward the new cycle instead of only the repeated one.
  expect(third.seen.length).toBe(9);
  expect(calls).toContain(24);
  const fourth = await chooseRandom({ browse, count: 9, seen: third.seen, pick: () => 0 });
  expect(fourth.ids.every((id) => !third.ids.includes(id))).toBe(true);
  expect(fourth.seen.length).toBe(18);
});

test('random rollover tolerates deleted history entries and duplicate catalog IDs', async () => {
  const holes = [
    ...Array.from({ length: 12 }, (unused, index) => ({ id: 'hole' + index })),
    { id: 'hole0' },
    { id: 'hole1' },
  ];
  const browse = async ({ offset }) => ({
    total: holes.length,
    holes: holes.slice(offset, offset + 24),
  });
  // History references courses that no longer exist in the catalog.
  const first = await chooseRandom({
    browse,
    count: 12,
    seen: ['deleted-a', 'hole0', 'deleted-b'],
    pick: () => 0,
  });
  expect(first.ids.filter((id) => id.startsWith('hole')).length).toBe(12);
  expect(new Set(first.ids).size).toBe(12);
  expect(first.seen.length).toBe(12);
  // A follow-up match rolls over into the duplicated remainder; with the
  // whole unique pool already played it must still return distinct IDs and
  // track exactly what it played.
  const second = await chooseRandom({ browse, count: 2, seen: first.seen, pick: () => 0 });
  expect(new Set(second.ids).size).toBe(2);
  expect(second.seen).toEqual(second.ids);
});

test('daily exclusion refreshes every match, covers every daily page, and allows future scheduled holes', async () => {
  const holes = Array.from({ length: 28 }, (unused, index) => ({ id: 'hole' + index }));
  holes[0].scheduledDay = 8;
  holes[1].scheduledDay = 12;
  let featured = [
    { id: 'hole0', scheduledDay: 8 },
    { id: 'hole1', scheduledDay: 12 },
    ...Array.from({ length: 23 }, (unused, index) => ({ id: 'other' + index, scheduledDay: 7 })),
    { id: 'hole2', scheduledDay: 9 },
  ];
  const requests = [];
  const browse = async (player) => {
    requests.push(player);
    const list = player.daily ? featured : holes;
    return {
      total: list.length,
      holes: list.slice(player.offset, player.offset + 24),
      nextOffset: player.offset + 24 < list.length ? player.offset + 24 : null,
    };
  };
  const first = await chooseRandom({
    browse,
    count: 3,
    excludeDaily: true,
    currentDay: 10,
    pick: () => 0,
  });
  expect(first.ids).toEqual(['hole1', 'hole3', 'hole4']);
  expect(requests.some((player) => player.daily && player.offset === 24 && player.fresh)).toBe(
    true,
  );
  featured = [...featured, { id: 'hole3', scheduledDay: 11 }];
  const second = await chooseRandom({
    browse,
    count: 3,
    excludeDaily: true,
    currentDay: 12,
    pick: () => 0,
  });
  expect(second.ids).toEqual(['hole4', 'hole5', 'hole6']);
  expect(requests.filter((player) => player.daily && player.offset === 0).length).toBe(2);
  const third = await chooseRandom({
    browse,
    count: 3,
    excludeDaily: false,
    currentDay: 12,
    pick: () => 0,
  });
  expect(third.ids).toEqual(['hole0', 'hole1', 'hole2']);
});

test('a failed checkpoint keeps the room usable instead of terminating the service', () => {
  const store = new RoomStore(':memory:');
  const room = new Room('ABCDE', new Map(), { onChange: (changedRoom) => store.save(changedRoom) });
  const host = room.issue('Host');
  const hostSocket = join(room, host, true);
  const messages = [];
  const originalError = console.error;
  console.error = (message) => messages.push(String(message));
  try {
    // A full disk or read-only database makes every write fail. The save path
    // must absorb that: previously the throw escaped through the room's change
    // callback and took the whole process down mid-match.
    store.db.exec('PRAGMA query_only=ON');
    expect(() => room.handle(hostSocket, { t: 'config', config: { locked: true } })).not.toThrow();
    expect(room.config.locked).toBe(true);
    expect(() => store.remove('ABCDE')).not.toThrow();
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain('Could not save room state');
    // Repeated failures are coalesced instead of flooding the log.
    store.save(room);
    expect(messages.length).toBe(1);
  } finally {
    console.error = originalError;
    store.db.exec('PRAGMA query_only=OFF');
  }
  // Once writes work again the row is rewritten, so restart recovery resumes.
  store.save(room);
  expect(store.db.query('SELECT payload FROM rooms WHERE code=?').get('ABCDE').payload).toContain(
    '"locked":true',
  );
  room.dispose();
  store.close();
});

test('host ownership and the hand-over record survive a restart', () => {
  const store = new RoomStore(':memory:');
  const room = new Room('ABCDE', new Map(), { onChange: (changedRoom) => store.save(changedRoom) });
  const host = room.issue('Host');
  const guest = room.issue('Guest');
  join(room, guest);
  join(room, host, true);
  room.handle(room.players.get(host.uid).ws, {
    t: 'host-action',
    action: 'transfer-host',
    uid: guest.uid,
    matchId: room.matchId,
    holeIndex: 0,
    requestId: 'xfer',
  });
  expect(room.hostUid).toBe(guest.uid);
  const token = room.hostToken;
  const restored = store.load(new Map(), {}).get('ABCDE');
  // A restart cannot resume the match, but it must not resurrect the old host
  // or hand its capability back.
  expect(restored.hostUid).toBe(guest.uid);
  expect(restored.hostToken).toBe(token);
  expect(restored.hostTransfer).toMatchObject({ fromUid: host.uid, toUid: guest.uid });
  room.dispose();
  store.close();
});

test('a daily hole that later became private is still excluded from random selection', async () => {
  // The published daily listing is a view over currently playable courses, so a
  // featured hole that was made private drops out of it entirely. Its day still
  // exists in the archive, so exclusion has to be driven by the catalog pages it
  // actually selects from: a private hole cannot be selected in the first place,
  // and a public hole that was featured keeps its scheduledDay and is excluded.
  const holes = [
    { id: 'was-featured', scheduledDay: 8 },
    { id: 'never-featured' },
    { id: 'future-featured', scheduledDay: 40 },
    { id: 'plain' },
  ];
  const requests = [];
  const browse = async (player) => {
    requests.push(player);
    const list = player.daily ? holes.filter((hole) => hole.scheduledDay !== undefined) : holes;
    return {
      total: list.length,
      holes: list.slice(player.offset, player.offset + 24),
      nextOffset: null,
    };
  };
  const picked = await chooseRandom({
    browse,
    count: 2,
    excludeDaily: true,
    currentDay: 10,
    pick: () => 0,
  });
  // The featured hole is skipped, the future-scheduled one is still playable,
  // and the private course never appears because the catalog does not list it.
  expect(picked.ids).toEqual(['never-featured', 'future-featured']);
});

test('a daily entry with no scheduledDay is treated as already featured', async () => {
  // A course can be featured and later lose its scheduledDay while remaining
  // public and listed. The daily listing is the authority on what has run, so a
  // dateless entry in it still counts as featured.
  const holes = [
    { id: 'featured-dateless' },
    { id: 'featured-dated', scheduledDay: 5 },
    { id: 'open-one' },
    { id: 'open-two' },
  ];
  const browse = async (player) => {
    const list = player.daily ? holes.slice(0, 2) : holes;
    return {
      total: list.length,
      holes: list.map((hole) => (player.daily ? { ...hole } : { ...hole })),
      nextOffset: null,
    };
  };
  const picked = await chooseRandom({
    browse,
    count: 2,
    excludeDaily: true,
    currentDay: 10,
    pick: () => 0,
  });
  expect(picked.ids).toEqual(['open-one', 'open-two']);
});

test('daily exclusion spans every page and prefers the newest listing over a cached one', async () => {
  // The listing paginates, and a partial read would silently let recent dailies
  // back into the pool. Every page is requested fresh so a cached page from
  // before today's hole cannot hide it.
  const holes = Array.from({ length: 40 }, (unused, index) => ({ id: 'open' + index }));
  const featured = [
    ...Array.from({ length: 24 }, (unused, index) => ({ id: 'featured' + index, scheduledDay: 1 })),
    { id: 'open0', scheduledDay: 9 },
    { id: 'open1', scheduledDay: 9 },
    { id: 'open2', scheduledDay: 9 },
    { id: 'open3', scheduledDay: 9 },
  ];
  const requests = [];
  const browse = async (player) => {
    requests.push(player);
    const list = player.daily ? featured : holes;
    return {
      total: list.length,
      holes: list.slice(player.offset, player.offset + 24),
      nextOffset: player.offset + 24 < list.length ? player.offset + 24 : null,
    };
  };
  const picked = await chooseRandom({
    browse,
    count: 2,
    excludeDaily: true,
    currentDay: 9,
    pick: (maximum) => maximum - 1,
  });
  // The four featured courses are the first positions, so the tail of the deck
  // is drawn and the featured ones are skipped only when they come up.
  expect(picked.ids).toEqual(['open39', 'open38']);
  const dailyRequests = requests.filter((player) => player.daily);
  expect(dailyRequests.map((player) => player.offset)).toEqual([0, 24]);
  expect(dailyRequests.every((player) => player.fresh === true)).toBe(true);
});

/**
 * A complete, valid checkpoint as a later process would find it. Tests start
 * from this and break exactly one thing so a rejection can only come from the
 * field under test.
 */
function checkpointPayload(overrides = {}) {
  return {
    version: 1,
    code: 'ABCDE',
    hostToken: 'host-token',
    hostUid: 'uid-host',
    hostTransfer: null,
    issued: [{ uid: 'uid-host', session: 'session-host', name: 'Host', hue: 200 }],
    config: {
      holes: 3,
      timerMs: 60000,
      elimination: true,
      maxPlayers: 50,
      mapSource: 'random',
      selectedHoleIds: [],
      locked: false,
      excludeDaily: false,
      randomHoles: 3,
      lateJoin: 'always',
      courseVoting: false,
    },
    titles: {},
    randomSeen: ['seen-before'],
    phase: 'lobby',
    starting: false,
    lastActivity: Date.now(),
    recoveryNotice: false,
    ...overrides,
  };
}

/** Place a raw payload in the store exactly as an earlier process left it. */
function seedRow(store, code, payload, updated = Date.now()) {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  store.db
    .query(
      'INSERT INTO rooms VALUES(?,?,?) ON CONFLICT(code) DO UPDATE SET payload=excluded.payload',
    )
    .run(code, updated, serialized);
}

function rowCount(store) {
  return store.db.query('SELECT COUNT(*) AS count FROM rooms').get().count;
}

/** Collect the loader's log lines so a test can assert why a row was skipped. */
function captureErrors(callback) {
  const messages = [];
  const originalError = console.error;
  console.error = (message) => messages.push(String(message));
  try {
    return { result: callback(), messages };
  } finally {
    console.error = originalError;
  }
}

test('unparseable and non-object payloads are skipped, kept for inspection, and do not stop a good room loading', () => {
  const store = new RoomStore(':memory:');
  seedRow(store, 'ABCDE', checkpointPayload());
  seedRow(store, 'BADJ1', '{"version":1,"code":"BADJ1"');
  seedRow(store, 'BADJ2', '[1,2,3]');
  seedRow(store, 'BADJ3', 'null');
  seedRow(store, 'BADJ4', '"a string payload"');
  const { result: rooms, messages } = captureErrors(() => store.load(new Map()));
  expect([...rooms.keys()]).toEqual(['ABCDE']);
  // A damaged row is not deleted or rewritten: it is the only copy of whatever
  // credentials it still holds, and an operator may want to inspect it.
  expect(rowCount(store)).toBe(5);
  expect(store.db.query('SELECT payload FROM rooms WHERE code=?').get('BADJ1').payload).toBe(
    '{"version":1,"code":"BADJ1"',
  );
  expect(messages.filter((message) => message.includes('not valid JSON')).length).toBe(1);
  expect(messages.filter((message) => message.includes('not a JSON object')).length).toBe(3);
  rooms.get('ABCDE').dispose();
  store.close();
});

test('a checkpoint from another schema version is skipped as unsupported, not mistaken for corruption', () => {
  const store = new RoomStore(':memory:');
  seedRow(store, 'ABCDE', checkpointPayload());
  seedRow(store, 'NEWER', checkpointPayload({ code: 'NEWER', version: 2 }));
  seedRow(store, 'OLDER', checkpointPayload({ code: 'OLDER', version: 0 }));
  seedRow(store, 'TYPED', checkpointPayload({ code: 'TYPED', version: '1' }));
  const { result: rooms, messages } = captureErrors(() => store.load(new Map()));
  expect([...rooms.keys()]).toEqual(['ABCDE']);
  // An unsupported version stays on disk so a later build can migrate it, and
  // the log says which case it was so the two are not confused operationally.
  expect(rowCount(store)).toBe(4);
  expect(messages.filter((message) => message.includes('unsupported-version')).length).toBe(2);
  expect(messages.filter((message) => message.includes('(corrupt)')).length).toBe(1);
  rooms.get('ABCDE').dispose();
  store.close();
});

test('a checkpoint missing a required field is rejected instead of half-restoring a room', () => {
  const store = new RoomStore(':memory:');
  seedRow(store, 'ABCDE', checkpointPayload());
  for (const missing of ['hostToken', 'code', 'issued', 'config', 'titles', 'randomSeen']) {
    const payload = checkpointPayload({ code: missing });
    delete payload[missing];
    seedRow(store, missing, payload);
  }
  const { result: rooms, messages } = captureErrors(() => store.load(new Map()));
  expect([...rooms.keys()]).toEqual(['ABCDE']);
  // In particular a room whose host token is missing must not come back, because
  // every later host check would compare against undefined and admit anyone.
  expect(rooms.get('hostToken')).toBeUndefined();
  expect(rowCount(store)).toBe(7);
  expect(messages.filter((message) => message.includes('(corrupt)')).length).toBe(6);
  rooms.get('ABCDE').dispose();
  store.close();
});

test('configuration outside the bounds the room itself enforces is rejected', () => {
  const invalidConfigs = [
    { timerMs: -1 },
    { timerMs: 86401000 },
    { timerMs: 60000.5 },
    { timerMs: '60000' },
    { maxPlayers: 51 },
    { maxPlayers: 0 },
    { elimination: 'yes' },
    { locked: 1 },
    { excludeDaily: null },
    { mapSource: 'remote' },
    { holes: 0 },
    { holes: 10001 },
    { randomHoles: 10001 },
    { selectedHoleIds: 'public1' },
    { selectedHoleIds: [''] },
    { selectedHoleIds: [7] },
    { selectedHoleIds: [null] },
    // Late joining is a named policy, and course voting is a flag. A row cannot
    // smuggle an unrecognised policy or a truthy stand-in past the live rules.
    { lateJoin: 'sometimes' },
    { lateJoin: true },
    { lateJoin: null },
    { courseVoting: 'true' },
    { courseVoting: 1 },
  ];
  const store = new RoomStore(':memory:');
  seedRow(store, 'ABCDE', checkpointPayload());
  invalidConfigs.forEach((config, index) => {
    const code = 'CFG' + index;
    seedRow(
      store,
      code,
      checkpointPayload({ code, config: { ...checkpointPayload().config, ...config } }),
    );
  });
  const { result: rooms, messages } = captureErrors(() => store.load(new Map()));
  // Without structural validation the out-of-range values were spread over the
  // defaults, so a 1-second timer or 51 players came back as accepted settings.
  expect([...rooms.keys()]).toEqual(['ABCDE']);
  expect(messages.filter((message) => message.includes('(corrupt)')).length).toBe(
    invalidConfigs.length,
  );
  rooms.get('ABCDE').dispose();
  store.close();
});

test('malformed identities are rejected rather than becoming join credentials', () => {
  const store = new RoomStore(':memory:');
  seedRow(store, 'ABCDE', checkpointPayload());
  const malformed = {
    HUE: [{ uid: 'uid-host', session: 'session-host', name: 'Host', hue: 400 }],
    HUG: [{ uid: 'uid-host', session: 'session-host', name: 'Host', hue: -1 }],
    HUH: [{ uid: 'uid-host', session: 'session-host', name: 'Host', hue: 1.5 }],
    NON: ['not-an-identity'],
    DUP: [
      { uid: 'uid-host', session: 'session-one', name: 'Host', hue: 10 },
      { uid: 'uid-host', session: 'session-two', name: 'Impostor', hue: 20 },
    ],
  };
  for (const [code, issued] of Object.entries(malformed)) {
    seedRow(store, code, checkpointPayload({ code, issued }));
  }
  const { result: rooms, messages } = captureErrors(() => store.load(new Map()));
  expect([...rooms.keys()]).toEqual(['ABCDE']);
  expect(messages.filter((message) => message.includes('(corrupt)')).length).toBe(5);
  rooms.get('ABCDE').dispose();
  store.close();
});

test('an oversized random history is trimmed to the room cap instead of being rejected or exhausting memory', () => {
  const store = new RoomStore(':memory:');
  const history = Array.from({ length: 12000 }, (unused, index) => 'seen-' + index);
  seedRow(store, 'ABCDE', checkpointPayload({ randomSeen: history }));
  seedRow(
    store,
    'HUGE',
    checkpointPayload({ code: 'HUGE', randomSeen: new Array(200000).fill('x') }),
  );
  const rows = store.load(new Map());
  expect([...rows.keys()].sort()).toEqual(['ABCDE', 'HUGE']);
  expect(rows.get('ABCDE').randomSeen.length).toBe(10000);
  expect(rows.get('ABCDE').randomSeen[0]).toBe('seen-0');
  expect(rows.get('HUGE').randomSeen.length).toBe(10000);
  rows.get('ABCDE').dispose();
  rows.get('HUGE').dispose();
  store.close();
});

test('a malformed match history is rejected rather than half-loaded', () => {
  const store = new RoomStore(':memory:');
  seedRow(store, 'ABCDE', checkpointPayload());
  const match = {
    matchId: 'match-1',
    endedAt: Date.now(),
    holes: 1,
    courses: [{ id: 'public1', title: 'Course', par: 3 }],
    standings: [{ name: 'Host', rank: 1, holesSurvived: 1, totalStrokes: 2, totalTimeMs: 1000 }],
  };
  const malformed = {
    NOTARR: 'nope',
    TOOMANY: new Array(11).fill(match),
    NOMID: [{ ...match, matchId: '' }],
    BADEND: [{ ...match, endedAt: 'yesterday' }],
    BADHOLES: [{ ...match, holes: -1 }],
    NOCOURSES: [{ ...match, courses: 'nope' }],
    BADCOURSE: [{ ...match, courses: [{ id: '', title: 'Course', par: 3 }] }],
    BADPAR: [{ ...match, courses: [{ id: 'public1', title: 'Course', par: 'three' }] }],
    NOROWS: [{ ...match, standings: 'nope' }],
    BADRANK: [{ ...match, standings: [{ ...match.standings[0], rank: 0 }] }],
    BADNAME: [{ ...match, standings: [{ ...match.standings[0], name: '' }] }],
    BADSTROKES: [{ ...match, standings: [{ ...match.standings[0], totalStrokes: -1 }] }],
  };
  for (const [code, matchHistory] of Object.entries(malformed)) {
    seedRow(store, code, checkpointPayload({ code, matchHistory }));
  }
  const { result: rooms, messages } = captureErrors(() => store.load(new Map()));
  expect([...rooms.keys()]).toEqual(['ABCDE']);
  expect(messages.filter((message) => message.includes('(corrupt)')).length).toBe(
    Object.keys(malformed).length,
  );
  rooms.get('ABCDE').dispose();
  store.close();
});

test('an oversized payload is refused before it is parsed into memory', () => {
  const store = new RoomStore(':memory:');
  seedRow(store, 'ABCDE', checkpointPayload());
  // Padding inside a string field keeps the JSON syntactically valid, so only
  // the size guard can stop the row from being decoded and walked.
  seedRow(store, 'FAT', '{"version":1,"code":"FAT","padding":"' + 'x'.repeat(2_100_000) + '"}');
  const { result: rooms, messages } = captureErrors(() => store.load(new Map()));
  expect([...rooms.keys()]).toEqual(['ABCDE']);
  expect(messages.some((message) => message.includes('characters, more than the supported'))).toBe(
    true,
  );
  expect(rowCount(store)).toBe(2);
  rooms.get('ABCDE').dispose();
  store.close();
});

test('a payload saved under the wrong room code is not resurrected under a different code', () => {
  const store = new RoomStore(':memory:');
  seedRow(store, 'ZZZZZ', checkpointPayload({ code: 'ABCDE' }));
  const { result: rooms, messages } = captureErrors(() => store.load(new Map()));
  expect(rooms.size).toBe(0);
  expect(messages.some((message) => message.includes('payload names the room'))).toBe(true);
  expect(rowCount(store)).toBe(1);
  store.close();
});

test('a row written before the random-hole setting existed is migrated, not discarded', () => {
  const store = new RoomStore(':memory:');
  const legacyRandom = checkpointPayload({ code: 'LEGACY' });
  delete legacyRandom.config.randomHoles;
  legacyRandom.config.holes = 7;
  seedRow(store, 'LEGACY', legacyRandom);
  const legacyPicked = checkpointPayload({ code: 'LEGACP' });
  delete legacyPicked.config.randomHoles;
  legacyPicked.config.mapSource = 'picked';
  legacyPicked.config.holes = 4;
  seedRow(store, 'LEGACP', legacyPicked);
  const rooms = store.load(new Map());
  // A random room keeps its hole count; a manual playlist keeps the historical
  // default of three, which is what Room.restore would have chosen.
  expect(rooms.get('LEGACY').config.randomHoles).toBe(7);
  expect(rooms.get('LEGACP').config.randomHoles).toBe(3);
  expect(rooms.get('LEGACY').config.mapSource).toBe('random');
  rooms.get('LEGACY').dispose();
  rooms.get('LEGACP').dispose();
  store.close();
});

test('a well-formed checkpoint restores every persisted field', () => {
  const store = new RoomStore(':memory:');
  const transfer = { fromUid: 'uid-old', toUid: 'uid-host', at: 1700000000000 };
  seedRow(
    store,
    'ABCDE',
    checkpointPayload({
      hostTransfer: transfer,
      issued: [
        { uid: 'uid-host', session: 'session-host', name: 'Host', hue: 359 },
        { uid: 'uid-guest', session: 'session-guest', name: 'Guest', hue: 0 },
      ],
      config: {
        holes: 2,
        timerMs: 127000,
        elimination: false,
        maxPlayers: 8,
        mapSource: 'picked',
        selectedHoleIds: ['public1', 'public2'],
        locked: true,
        excludeDaily: true,
        randomHoles: 5,
        lateJoin: 'next-hole',
        courseVoting: true,
      },
      titles: { public1: 'First', public2: 'Second' },
      randomSeen: ['seen-before', 'seen-again'],
      phase: 'playing',
      starting: false,
      recoveryNotice: false,
    }),
  );
  const catalog = new Map();
  const rooms = store.load(catalog);
  const room = rooms.get('ABCDE');
  expect(room.hostToken).toBe('host-token');
  expect(room.hostUid).toBe('uid-host');
  expect(room.hostTransfer).toEqual(transfer);
  expect(room.issued.get('uid-guest')).toEqual({
    uid: 'uid-guest',
    session: 'session-guest',
    name: 'Guest',
    hue: 0,
  });
  expect(room.config).toEqual({
    holes: 2,
    timerMs: 127000,
    elimination: false,
    maxPlayers: 8,
    mapSource: 'picked',
    selectedHoleIds: ['public1', 'public2'],
    locked: true,
    excludeDaily: true,
    randomHoles: 5,
    lateJoin: 'next-hole',
    courseVoting: true,
  });
  expect(room.randomSeen).toEqual(['seen-before', 'seen-again']);
  // Play cannot resume after a restart, so a mid-match row recovers as a lobby.
  expect(room.phase).toBe('lobby');
  expect(room.recoveryNotice).toBe(true);
  expect(catalog.get('public1')).toEqual({ id: 'public1', title: 'First' });
  expect(catalog.get('public2')).toEqual({ id: 'public2', title: 'Second' });
  room.dispose();
  store.close();
});
