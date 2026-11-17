import { test, expect } from 'bun:test';
import { Room } from '../src/room.js';
const spec = { id: 'public-level', name: 'Example', par: 3 };
const maps = new Map([
  ['p', { id: 'p', spec }],
  ['q', { id: 'q', spec: { ...spec, id: 'next', par: 2 } }],
]);
const socket = () => ({
  data: {},
  frames: [],
  send(serializedMessage) {
    this.frames.push(JSON.parse(serializedMessage));
  },
  close() {
    this.closed = true;
  },
});
const enter = (room, name, host = false) => {
  const identity = room.issue(name);
  const ws = socket();
  room.handle(ws, {
    t: 'join',
    ...identity,
    protocol: 2,
    ...(host ? { host: room.hostToken } : {}),
  });
  return { ws, identity, player: room.players.get(identity.uid) };
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForRoom(condition, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Room did not reach the expected state');
    }
    await delay(5);
  }
}

test('only independently issued identity may join; admin is token bound', () => {
  const room = new Room('ABCDE', maps);
  const bad = socket();
  room.handle(bad, { t: 'join', uid: 'arbitrary', name: 'fake', protocol: 2 });
  expect(bad.closed).toBe(true);
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  expect(room.roster().map((player) => player.isHost)).toEqual([true, false]);
  room.handle(guest.ws, { t: 'config', config: { holes: 9 } });
  expect(room.config.holes).toBe(3);
  room.handle(guest.ws, { t: 'start' });
  expect(room.phase).toBe('lobby');
  expect(host.ws.frames.some((frame) => frame.t === 'hello' && frame.isHost)).toBe(true);
  expect(guest.ws.frames.some((frame) => frame.t === 'error')).toBe(true);
  room.dispose();
});
test('ready and roster; partial config retains values; duplicate playlist IDs accepted', () => {
  const room = new Room('ABCDE', maps);
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  room.handle(guest.ws, { t: 'ready', v: true });
  expect(room.roster().find((player) => player.uid === guest.identity.uid).ready).toBe(true);
  room.handle(host.ws, {
    t: 'config',
    config: {
      mapSource: 'picked',
      selectedHoleIds: ['p', 'p'],
      timerMs: 20000,
      elimination: false,
    },
  });
  expect(room.config).toMatchObject({
    mapSource: 'picked',
    holes: 2,
    selectedHoleIds: ['p', 'p'],
    timerMs: 20000,
    elimination: false,
    maxPlayers: 50,
  });
  room.handle(host.ws, { t: 'config', config: { selectedHoleIds: ['missing'] } });
  expect(room.config.selectedHoleIds).toEqual(['p', 'p']);
  room.dispose();
});
test('two rounds: immutable map, real protocol shapes, idempotent completion, final and rematch', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q'], elimination: false },
  });
  room.handle(host.ws, { t: 'start' });
  expect(room.phase).toBe('countdown');
  expect(room.snapshot().currentMap.id).toBe('public-level');
  const id = room.matchId;
  room.handle(host.ws, { f: 1, s: 1, p: 3 });
  expect(host.player.done).toBe(false);
  await delay(12);
  expect(room.phase).toBe('playing');
  room.handle(host.ws, { t: 'prog', st: 2 });
  expect(host.player.strokes).toBe(2);
  room.handle(host.ws, { f: 1, s: 1, p: 3 });
  expect(host.player.done).toBe(false);
  room.handle(host.ws, { f: 1, s: 2, p: 3 });
  expect(host.player.done).toBe(true);
  room.handle(host.ws, { f: 1, s: 3, p: 3 });
  expect(host.player.strokes).toBe(2);
  room.handle(guest.ws, { f: 1, s: 3, p: 3 });
  expect(room.phase).toBe('hole-results');
  await waitForRoom(() => room.phase === 'playing' && room.holeIndex === 1);
  expect(room.phase).toBe('playing');
  expect(room.holeIndex).toBe(1);
  expect(room.matchId).toBe(id);
  expect(room.snapshot().currentMap.id).toBe('next');
  room.handle(guest.ws, { t: 'forfeit' });
  room.handle(host.ws, { f: 1, s: 1, p: 2 });
  await delay(15);
  expect(room.phase).toBe('final');
  expect(room.standings()[0].uid).toBe(host.identity.uid);
  expect(host.ws.frames.some((message) => message.t === 'final')).toBe(true);
  room.handle(host.ws, { t: 'rematch' });
  expect(room.phase).toBe('lobby');
  expect(room.matchId).toBe(null);
  expect(room.snapshot().holeIds).toEqual([]);
  room.dispose();
});
test('connect and disconnect preserve identity and remove ghost; late join spectators', () => {
  const room = new Room('ABCDE', maps, { countdown: 10000 });
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  room.handle(host.ws, { t: 'start' });
  const late = enter(room, 'Late');
  expect(late.player.role).toBe('spectator');
  room.close(guest.ws);
  expect(host.ws.frames.some((frame) => frame.t === 'bye' && frame.id === guest.player.id)).toBe(
    true,
  );
  const old = guest.player.id;
  const ws = socket();
  room.handle(ws, { t: 'join', ...guest.identity, protocol: 2 });
  expect(room.players.get(guest.identity.uid).id).not.toBe(old);
  expect(ws.frames.find((frame) => frame.t === 'party').matchId).toBe(room.matchId);
  room.dispose();
});
test('presence relays by server socket ID and rejects invalid numbers', () => {
  const room = new Room('ABCDE', maps, { countdown: 1000 });
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  room.handle(host.ws, { t: 'start' });
  room.handle(guest.ws, { x: 1, y: 2, z: 3, px: 0, pz: 0, c: 1, m: 1, d: 4, id: 'forged-id' });
  room.tick();
  expect(host.ws.frames.at(-1)).toMatchObject({
    t: 'b',
    s: [{ id: guest.player.id, x: 1, y: 2, z: 3, c: 1, m: 1 }],
  });
  room.handle(guest.ws, { x: Infinity, y: 2, z: 3, px: 0, pz: 0, c: 1, m: 1 });
  expect(room.positions.size).toBe(0);
  room.dispose();
});
test('roster-visible UID is not a reconnect credential; secret is never published', () => {
  const room = new Room('ABCDE', maps);
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  expect(host.identity.uid).not.toBe(host.identity.session);
  const impersonator = socket();
  room.handle(impersonator, { t: 'join', uid: host.identity.uid, protocol: 2 });
  expect(impersonator.closed).toBe(true);
  expect(room.players.get(host.identity.uid).ws).toBe(host.ws);
  expect(() => room.issue('Host', host.identity.uid, 'wrong-secret')).toThrow();
  expect(room.issue('Host', host.identity.uid, host.identity.session)).toEqual(host.identity);
  expect(JSON.stringify(guest.ws.frames)).not.toContain(host.identity.session);
  expect(JSON.stringify(host.ws.frames)).not.toContain(guest.identity.session);
  room.dispose();
});
test('elimination advances all successful players and rejects non-finishers', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const host = enter(room, 'H', true);
  const guest = enter(room, 'G');
  const key = enter(room, 'K');
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q'] },
  });
  room.handle(host.ws, { t: 'start' });
  await delay(10);
  room.handle(host.ws, { f: 1, s: 1, p: 3 });
  room.handle(guest.ws, { f: 1, s: 4, p: 3 });
  room.handle(key.ws, { t: 'forfeit' });
  expect(room.phase).toBe('hole-results');
  expect(host.player.alive).toBe(true);
  expect(guest.player.alive).toBe(true);
  expect(key.player.alive).toBe(false);
  expect(key.player.holesSurvived).toBe(0);
  expect(key.player.role).toBe('spectator');
  await waitForRoom(() => room.phase === 'playing' && room.holeIndex === 1);
  expect(room.phase).toBe('playing');
  expect(room.holeIndex).toBe(1);
  expect(room.board().alive).toBe(2);
  room.dispose();
});
test('a full reload during play cannot reset progress; ordinary reconnect preserves progress', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const host = enter(room, 'Host', true);
  const identity = room.issue('Guest');
  const ws = socket();
  room.handle(ws, { t: 'join', ...identity, instance: 'page1', protocol: 2 });
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q'], elimination: false },
  });
  room.handle(host.ws, { t: 'start' });
  await delay(10);
  room.handle(ws, { t: 'prog', st: 4 });
  room.close(ws);
  const reconnect = socket();
  room.handle(reconnect, { t: 'join', ...identity, instance: 'page1', protocol: 2 });
  const player = room.players.get(identity.uid);
  expect(player.strokes).toBe(4);
  expect(player.done).toBe(false);
  const reload = socket();
  room.handle(reload, { t: 'join', ...identity, instance: 'page2', protocol: 2 });
  expect(player.role).toBe('spectator');
  expect(player.done).toBe(true);
  expect(player.strokes).toBe(4);
  room.handle(host.ws, { f: 1, s: 2, p: 3 });
  await delay(20);
  expect(room.holeIndex).toBe(1);
  expect(player.role).toBe('player');
  expect(player.strokes).toBe(0);
  expect(player.done).toBe(false);
  room.dispose();
});
test('asynchronous map preparation locks configuration and rolls back on failure', async () => {
  let reject;
  const room = new Room('ABCDE', maps, {
    prepareMatch: () => new Promise((unused, rejectPreparation) => (reject = rejectPreparation)),
  });
  const host = enter(room, 'Host', true);
  room.handle(host.ws, { t: 'start' });
  await delay(1);
  expect(room.snapshot().preparing).toBe(true);
  room.handle(host.ws, { t: 'config', config: { holes: 9 } });
  expect(room.config.holes).toBe(3);
  reject(Error('upstream unavailable'));
  await delay(1);
  expect(room.snapshot().preparing).toBe(false);
  expect(room.phase).toBe('lobby');
  expect(host.ws.frames.some((message) => message.code === 'map-load-failed')).toBe(true);
  room.dispose();
});
test('progress can return to zero when the original client resets its first shot', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5 });
  const host = enter(room, 'Host', true);
  room.handle(host.ws, { t: 'start' });
  await delay(10);
  room.handle(host.ws, { t: 'prog', st: 1 });
  room.handle(host.ws, { t: 'prog', st: 0 });
  expect(host.player.strokes).toBe(0);
  room.dispose();
});

test('host timer extensions are authoritative and do not affect next hole', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  room.handle(host.ws, {
    t: 'config',
    config: {
      mapSource: 'picked',
      selectedHoleIds: ['p', 'q'],
      elimination: false,
      timerMs: 20000,
    },
  });
  room.handle(host.ws, { t: 'start' });
  await delay(12);
  const action = {
    t: 'host-action',
    action: 'time',
    seconds: 30,
    matchId: room.matchId,
    holeIndex: 0,
  };
  room.handle(guest.ws, action);
  expect(room.snapshot().timerMs).toBe(20000);
  expect(guest.ws.frames.at(-1).code).toBe('not-host');
  room.handle(host.ws, { ...action, seconds: -1 });
  expect(room.snapshot().timerMs).toBe(20000);
  room.handle(host.ws, action);
  expect(room.snapshot().timerMs).toBe(50000);
  expect(room.config.timerMs).toBe(20000);
  expect(guest.ws.frames.at(-1).timerMs).toBe(50000);
  room.handle(host.ws, { ...action, holeIndex: 1 });
  expect(room.snapshot().timerMs).toBe(50000);
  room.handle(host.ws, { f: 1, s: 1, p: 3 });
  room.handle(guest.ws, { f: 1, s: 2, p: 3 });
  await delay(20);
  expect(room.holeIndex).toBe(1);
  expect(room.snapshot().timerMs).toBe(20000);
  room.dispose();
});
test('host skip voids a round without score or eliminations; restart retains prior rounds; end shows final', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q', 'p'], elimination: false },
  });
  room.handle(host.ws, { t: 'start' });
  await delay(10);
  room.handle(host.ws, { f: 1, s: 2, p: 3 });
  room.handle(guest.ws, { f: 1, s: 4, p: 3 });
  await delay(20);
  const action = (name) => ({
    t: 'host-action',
    action: name,
    matchId: room.matchId,
    holeIndex: room.holeIndex,
  });
  room.handle(host.ws, { t: 'prog', st: 3 });
  const old = room.matchId;
  room.handle(host.ws, action('restart'));
  expect(room.matchId).not.toBe(old);
  expect(room.holeIndex).toBe(1);
  expect(host.player.strokes).toBe(0);
  expect(host.player.totalStrokes).toBe(2);
  const stale = action('skip');
  room.handle(host.ws, stale);
  expect(room.holeIndex).toBe(2);
  expect(host.player.totalStrokes).toBe(2);
  expect(guest.player.alive).toBe(true);
  room.handle(host.ws, stale);
  expect(room.holeIndex).toBe(2);
  room.handle(host.ws, action('end'));
  expect(room.phase).toBe('final');
  expect(host.player.holesSurvived).toBe(1);
  expect(guest.ws.frames.at(-1).t).toBe('final');
  room.handle(host.ws, { t: 'rematch' });
  expect(room.phase).toBe('lobby');
  room.dispose();
});

test('host commands acknowledge success, stale rounds and unauthorized requests', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5 });
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  room.handle(host.ws, { t: 'start' });
  await delay(12);
  const action = {
    t: 'host-action',
    action: 'time',
    seconds: 30,
    matchId: room.matchId,
    holeIndex: 0,
    requestId: 'test',
  };
  room.handle(host.ws, action);
  expect(host.ws.frames.at(-1)).toMatchObject({ t: 'host-ack', requestId: 'test', ok: true });
  room.handle(guest.ws, action);
  expect(guest.ws.frames.at(-1)).toMatchObject({ t: 'host-ack', ok: false });
  room.handle(host.ws, { ...action, holeIndex: 2 });
  expect(host.ws.frames.at(-1)).toMatchObject({ t: 'host-ack', ok: false });
  room.handle(host.ws, { t: 'ping' });
  expect(host.ws.frames.at(-1).t).toBe('pong');
  room.dispose();
});

test('solo elimination plays all successful holes and records scorecard', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const host = enter(room, 'Solo', true);
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q'], elimination: true },
  });
  room.handle(host.ws, { t: 'start' });
  await delay(12);
  room.handle(host.ws, { f: 1, s: 2, p: 3 });
  await waitForRoom(() => room.phase === 'playing' && room.holeIndex === 1);
  expect(room.phase).toBe('playing');
  expect(room.holeIndex).toBe(1);
  expect(room.roundHistory[0].rows[0]).toMatchObject({
    uid: host.identity.uid,
    strokes: 2,
    status: 'holed',
  });
  room.handle(host.ws, { f: 1, s: 3, p: 2 });
  await delay(12);
  expect(room.phase).toBe('final');
  expect(room.roundHistory.length).toBe(2);
  expect(room.standings()[0].totalStrokes).toBe(5);
  room.handle(host.ws, { t: 'rematch' });
  expect(room.roundHistory).toEqual([]);
  room.dispose();
});
test('late previous-round packets are ignored and host skips appear in history', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5 });
  const host = enter(room, 'Host', true);
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q'], elimination: false },
  });
  room.handle(host.ws, { t: 'start' });
  await delay(10);
  const old = { matchId: room.matchId, holeIndex: 0 };
  room.handle(host.ws, { t: 'host-action', action: 'skip', ...old });
  await delay(10);
  expect(room.roundHistory[0]).toMatchObject({ index: 0, status: 'skipped', rows: [] });
  room.handle(host.ws, { t: 'prog', st: 9, ...old });
  room.handle(host.ws, { t: 'forfeit', ...old });
  expect(host.player.strokes).toBe(0);
  expect(host.player.done).toBe(false);
  room.handle(host.ws, { t: 'prog', st: 2, matchId: room.matchId, holeIndex: 1 });
  expect(host.player.strokes).toBe(2);
  room.dispose();
});

test('manual playlists exceed nine holes, random count is independent, and custom seconds validate', () => {
  const room = new Room('ABCDE', maps);
  const host = enter(room, 'Host', true);
  room.handle(host.ws, { t: 'config', config: { holes: 7, timerMs: 127000, excludeDaily: true } });
  expect(room.config.holes).toBe(7);
  expect(room.config.timerMs).toBe(127000);
  const ids = Array.from({ length: 153 }, (unused, index) => (index % 2 ? 'q' : 'p'));
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ids, holes: ids.length },
  });
  expect(room.config.holes).toBe(153);
  expect(room.config.selectedHoleIds).toEqual(ids);
  expect(room.config.randomHoles).toBe(7);
  room.handle(host.ws, { t: 'config', config: { mapSource: 'random' } });
  expect(room.config.holes).toBe(7);
  expect(room.config.excludeDaily).toBe(true);
  room.handle(host.ws, { t: 'config', config: { holes: 10 } });
  expect(room.config.holes).toBe(7);
  room.handle(host.ws, { t: 'config', config: { timerMs: 301000 } });
  expect(room.config.timerMs).toBe(127000);
  room.dispose();
});
test('lazy manual map preparation reaches later rounds and can be interrupted safely', async () => {
  let resolveLoad;
  const loads = [];
  const room = new Room('ABCDE', maps, {
    countdown: 5,
    results: 5,
    prepareMatch: async (connection) => ({
      ids: connection.selectedHoleIds,
      specs: [maps.get('p').spec],
    }),
    loadMap: (id) => {
      loads.push(id);
      return new Promise((resolve) => (resolveLoad = resolve));
    },
  });
  const host = enter(room, 'Host', true);
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q', 'p'], elimination: false },
  });
  room.handle(host.ws, { t: 'start' });
  await delay(15);
  expect(room.phase).toBe('playing');
  room.handle(host.ws, { t: 'host-action', action: 'skip', matchId: room.matchId, holeIndex: 0 });
  await delay(1);
  expect(room.snapshot().preparing).toBe(true);
  expect(room.holeIndex).toBe(0);
  expect(loads).toEqual(['q']);
  resolveLoad(maps.get('q'));
  await delay(12);
  expect(room.holeIndex).toBe(1);
  expect(room.phase).toBe('playing');
  expect(room.snapshot().preparing).toBe(false);
  room.handle(host.ws, { t: 'host-action', action: 'skip', matchId: room.matchId, holeIndex: 1 });
  await delay(1);
  room.handle(host.ws, { t: 'host-action', action: 'end', matchId: room.matchId, holeIndex: 1 });
  resolveLoad(maps.get('p'));
  await delay(12);
  expect(room.phase).toBe('final');
  expect(room.holeIndex).toBe(1);
  room.dispose();
});

test('admission capacity rejects full rooms consistently, including host-token holders', () => {
  const room = new Room('ABCDE', maps);
  enter(room, 'Host', true);
  enter(room, 'Guest One');
  // A credential issued while the room still has room, then the room fills
  // before the socket joins: admission must still reject it.
  const tokenHolder = room.issue('Token Holder');
  enter(room, 'Guest Two');
  room.handle(
    [...room.players.values()].find((player) => player.uid === room.hostUid)?.ws ?? socket(),
    { t: 'config', config: { maxPlayers: 3 } },
  );
  // The host token alone must not claim a slot in a full room because this
  // identity does not claim host authority.
  const tokenSocket = socket();
  room.handle(tokenSocket, {
    t: 'join',
    ...tokenHolder,
    protocol: 2,
    host: room.hostToken,
  });
  expect(tokenSocket.closed).toBe(true);
  expect(tokenSocket.frames.some((frame) => frame.t === 'error' && frame.code === 'full')).toBe(
    true,
  );
  // A returning connected player keeps the slot after maxPlayers is reduced.
  const returning = [...room.players.values()].find((player) => player.uid !== room.hostUid);
  const rejoin = socket();
  room.handle(rejoin, {
    t: 'join',
    uid: returning.uid,
    session: room.issued.get(returning.uid).session,
    protocol: 2,
    instance: 'again',
  });
  expect(rejoin.closed).toBeUndefined();
  expect(rejoin.frames.some((frame) => frame.t === 'hello')).toBe(true);
  room.dispose();
});

test('spectators count toward capacity and late joiners become spectators', () => {
  const room = new Room('ABCDE', maps, { countdown: 1 });
  const host = enter(room, 'Host', true);
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p'], maxPlayers: 2 },
  });
  // A credential issued in the lobby before the room fills.
  const third = room.issue('Third Guest');
  room.handle(host.ws, { t: 'start' });
  return waitForRoom(() => room.phase === 'playing').then(() => {
    const late = enter(room, 'Late Guest');
    expect(late.player.role).toBe('spectator');
    // The spectator occupies the last of two slots; the earlier-issued
    // credential is then rejected at socket admission.
    const thirdSocket = socket();
    room.handle(thirdSocket, { t: 'join', ...third, protocol: 2 });
    expect(thirdSocket.closed).toBe(true);
    expect(thirdSocket.frames.some((frame) => frame.t === 'error' && frame.code === 'full')).toBe(
      true,
    );
    room.dispose();
  });
});

test('match preparation survives a host reconnect and reports failure to the new socket', async () => {
  let resolvePreparation;
  const room = new Room('ABCDE', maps, {
    prepareMatch: () => new Promise((resolve) => (resolvePreparation = resolve)),
  });
  const host = enter(room, 'Host', true);
  room.handle(host.ws, { t: 'start' });
  await delay(1);
  expect(room.snapshot().preparing).toBe(true);
  // The original host socket disconnects and the identity reconnects with a
  // new socket while preparation is still in flight.
  room.close(host.ws);
  const reconnected = socket();
  room.handle(reconnected, { t: 'join', ...host.identity, protocol: 2, instance: 'again' });
  expect(reconnected.frames.some((frame) => frame.t === 'hello')).toBe(true);
  resolvePreparation({ ids: ['p'], specs: [maps.get('p').spec], seen: undefined });
  await delay(1);
  expect(room.phase).toBe('countdown');
  expect(room.snapshot().preparing).toBe(false);
  expect(reconnected.frames.some((frame) => frame.t === 'party' && frame.phase !== 'lobby')).toBe(
    true,
  );
  room.dispose();
});

test('failed preparation reports to the reconnected host socket', async () => {
  let rejectPreparation;
  const room = new Room('ABCDE', maps, {
    prepareMatch: () => new Promise((unused, reject) => (rejectPreparation = reject)),
  });
  const host = enter(room, 'Host', true);
  room.handle(host.ws, { t: 'start' });
  await delay(1);
  room.close(host.ws);
  const reconnected = socket();
  room.handle(reconnected, { t: 'join', ...host.identity, protocol: 2, instance: 'again' });
  rejectPreparation(Error('upstream unavailable'));
  await delay(1);
  expect(room.phase).toBe('lobby');
  expect(room.snapshot().preparing).toBe(false);
  expect(
    reconnected.frames.some((frame) => frame.t === 'error' && frame.code === 'map-load-failed'),
  ).toBe(true);
  room.dispose();
});
