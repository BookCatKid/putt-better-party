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
