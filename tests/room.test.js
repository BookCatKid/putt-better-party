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
  room.handle(host.ws, { t: 'config', config: { lateJoin: 'never' } });
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
  room.handle(host.ws, { t: 'config', config: { lateJoin: 'never' } });
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

test('next-course load failure is recoverable by retry, skip or end', async () => {
  let failNext = true;
  const loads = [];
  const room = new Room('ABCDE', maps, {
    countdown: 1,
    prepareMatch: async (connection) => ({
      ids: connection.selectedHoleIds,
      specs: [maps.get('p').spec],
    }),
    loadMap: (id) => {
      loads.push(id);
      return failNext
        ? Promise.reject(Error('upstream unavailable'))
        : Promise.resolve(maps.get(id));
    },
  });
  const host = enter(room, 'Host', true);
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q'], elimination: false },
  });
  room.handle(host.ws, { t: 'start' });
  await waitForRoom(() => room.phase === 'playing');
  room.handle(host.ws, { t: 'host-action', action: 'skip', matchId: room.matchId, holeIndex: 0 });
  await waitForRoom(() => room.snapshot().nextError !== null);
  // The match no longer terminates automatically; completed scores persist.
  expect(room.phase).toBe('hole-results');
  expect(room.snapshot().preparing).toBe(false);
  expect(room.roundHistory[0].status).toBe('skipped');
  expect(room.snapshot().nextError).toContain('Could not load the next public hole');
  // A duplicate retry while one is in flight is rejected.
  room.handle(host.ws, {
    t: 'host-action',
    action: 'retry-next',
    matchId: room.matchId,
    holeIndex: room.holeIndex,
    requestId: 'retry-one',
  });
  room.handle(host.ws, {
    t: 'host-action',
    action: 'retry-next',
    matchId: room.matchId,
    holeIndex: room.holeIndex,
    requestId: 'retry-two',
  });
  await delay(1);
  const acks = host.ws.frames.filter((frame) => frame.t === 'host-ack');
  expect(acks.find((frame) => frame.requestId === 'retry-one').ok).toBe(true);
  expect(acks.find((frame) => frame.requestId === 'retry-two').ok).toBe(false);
  // The first retry already failed; a further retry succeeds once upstream recovers.
  await waitForRoom(() => room.snapshot().nextError !== null && !room.snapshot().preparing);
  failNext = false;
  room.handle(host.ws, {
    t: 'host-action',
    action: 'retry-next',
    matchId: room.matchId,
    holeIndex: room.holeIndex,
    requestId: 'retry-three',
  });
  await waitForRoom(() => room.phase === 'playing' && room.holeIndex === 1);
  expect(room.snapshot().nextError).toBe(null);
  room.dispose();
});

test('skipping the unloaded hole voids it and continues or finalizes', async () => {
  let failFirst = true;
  const loads = [];
  const room = new Room('ABCDE', maps, {
    countdown: 1,
    prepareMatch: async (connection) => ({
      ids: connection.selectedHoleIds,
      specs: [maps.get('p').spec],
    }),
    loadMap: (id) => {
      loads.push(id);
      return failFirst
        ? Promise.reject(Error('upstream unavailable'))
        : Promise.resolve(maps.get(id));
    },
  });
  const host = enter(room, 'Host', true);
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q', 'p'], elimination: false },
  });
  room.handle(host.ws, { t: 'start' });
  await waitForRoom(() => room.phase === 'playing');
  room.handle(host.ws, { t: 'host-action', action: 'skip', matchId: room.matchId, holeIndex: 0 });
  await waitForRoom(() => room.snapshot().nextError !== null);
  failFirst = false;
  room.handle(host.ws, {
    t: 'host-action',
    action: 'skip-next',
    matchId: room.matchId,
    holeIndex: room.holeIndex,
    requestId: 'skip-next',
  });
  await delay(1);
  // The failed hole is recorded as skipped and the following hole loads.
  expect(room.roundHistory.some((round) => round.index === 1 && round.status === 'skipped')).toBe(
    true,
  );
  expect(loads).toEqual(['q', 'p']);
  await waitForRoom(() => room.phase === 'playing' && room.holeIndex === 2);
  expect(room.snapshot().nextError).toBe(null);
  room.dispose();
});
test('ending the party from a next-course failure keeps completed scores', async () => {
  const room = new Room('ABCDE', maps, {
    countdown: 1,
    results: 5,
    prepareMatch: async (connection) => ({
      ids: connection.selectedHoleIds,
      specs: [maps.get('p').spec],
    }),
    loadMap: () => Promise.reject(Error('upstream unavailable')),
  });
  const host = enter(room, 'Host', true);
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q'], elimination: false },
  });
  room.handle(host.ws, { t: 'start' });
  await waitForRoom(() => room.phase === 'playing');
  room.handle(host.ws, { f: 1, s: 2, p: 3 });
  // The results period passes, then the next course fails to load.
  await waitForRoom(() => room.snapshot().nextError !== null, 3000);
  room.handle(host.ws, { t: 'host-action', action: 'end', matchId: room.matchId, holeIndex: 0 });
  await delay(1);
  expect(room.phase).toBe('final');
  expect(room.standings()[0].totalStrokes).toBe(2);
  room.dispose();
});

test('the round timer starts only once declared-ready clients have their scene', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const hostIdentity = room.issue('Host');
  const guestIdentity = room.issue('Guest');
  const hostSocket = socket();
  const guestSocket = socket();
  // Both clients declare that they report scene readiness.
  room.handle(hostSocket, {
    t: 'join',
    ...hostIdentity,
    protocol: 2,
    host: room.hostToken,
    scene: true,
  });
  room.handle(guestSocket, { t: 'join', ...guestIdentity, protocol: 2, scene: true });
  room.handle(hostSocket, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q'], elimination: false },
  });
  room.handle(hostSocket, { t: 'start' });
  const matchId = room.matchId;
  room.handle(hostSocket, { t: 'scene', matchId, holeIndex: 0, levelId: 'p' });
  await delay(20);
  // The countdown elapsed but the guest's scene never reported: the round stays
  // in countdown and, crucially, the timer has not started running.
  expect(room.phase).toBe('countdown');
  expect(room.snapshot().awaitingPlayers).toBe(1);
  expect(room.snapshot().timerMs).toBe(60000);
  room.handle(guestSocket, { t: 'scene', matchId, holeIndex: 0, levelId: 'p' });
  await delay(5);
  expect(room.phase).toBe('playing');
  expect(room.snapshot().awaitingPlayers).toBe(0);
  // Play starts now, so the guest's loading time was never charged to the round.
  const startedAt = room.startsAt;
  await delay(15);
  expect(room.phase).toBe('playing');
  expect(room.startsAt).toBe(startedAt);
  room.dispose();
});

test('a stale or mismatched scene report cannot unblock a newer round', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const hostIdentity = room.issue('Host');
  const guestIdentity = room.issue('Guest');
  const hostSocket = socket();
  const guestSocket = socket();
  room.handle(hostSocket, {
    t: 'join',
    ...hostIdentity,
    protocol: 2,
    host: room.hostToken,
    scene: true,
  });
  room.handle(guestSocket, { t: 'join', ...guestIdentity, protocol: 2, scene: true });
  room.handle(hostSocket, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p'], elimination: false },
  });
  room.handle(hostSocket, { t: 'start' });
  room.handle(hostSocket, { t: 'scene', matchId: room.matchId, holeIndex: 0, levelId: 'p' });
  await delay(20);
  expect(room.phase).toBe('countdown');
  // Previous-round and wrong-level reports are both ignored.
  room.handle(guestSocket, { t: 'scene', matchId: 'stale-match', holeIndex: 0, levelId: 'p' });
  room.handle(guestSocket, { t: 'scene', matchId: room.matchId, holeIndex: 1, levelId: 'p' });
  room.handle(guestSocket, { t: 'scene', matchId: room.matchId, holeIndex: 0, levelId: 'q' });
  await delay(5);
  expect(room.phase).toBe('countdown');
  expect(room.snapshot().awaitingPlayers).toBe(1);
  room.handle(guestSocket, { t: 'scene', matchId: room.matchId, holeIndex: 0, levelId: 'p' });
  await delay(5);
  expect(room.phase).toBe('playing');
  room.dispose();
});

test('the readiness wait is bounded so one stalled client cannot hold the match', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const hostIdentity = room.issue('Host');
  const guestIdentity = room.issue('Guest');
  const hostSocket = socket();
  const guestSocket = socket();
  room.handle(hostSocket, {
    t: 'join',
    ...hostIdentity,
    protocol: 2,
    host: room.hostToken,
    scene: true,
  });
  room.handle(guestSocket, { t: 'join', ...guestIdentity, protocol: 2, scene: true });
  room.handle(hostSocket, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p'], elimination: false },
  });
  room.handle(hostSocket, { t: 'start' });
  room.handle(hostSocket, { t: 'scene', matchId: room.matchId, holeIndex: 0, levelId: 'p' });
  await delay(20);
  expect(room.phase).toBe('countdown');
  // The grace deadline is bounded rather than indefinite.
  expect(room.readyDeadline).toBeGreaterThan(Date.now());
  expect(room.readyDeadline - Date.now()).toBeLessThanOrEqual(10_000);
  // Standing in for wall-clock passage: the gate releases at the deadline.
  room.readyDeadline = Date.now() - 1;
  room.startPlay();
  expect(room.phase).toBe('playing');
  expect(room.snapshot().awaitingPlayers).toBe(0);
  room.dispose();
});

test('a bare claim to host authority cannot dodge the read-only mapping of readiness', async () => {
  // Clients that do not announce scene reporting are never awaited, so the
  // existing 5 second countdown behaviour is preserved for them.
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const host = enter(room, 'Host', true);
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p'], elimination: false },
  });
  room.handle(host.ws, { t: 'start' });
  await delay(15);
  expect(room.phase).toBe('playing');
  room.dispose();
});

test('a readiness report may name the course by its specification id', async () => {
  // The catalog addresses a course by its public id while the renderer and the
  // course specification name the same course by its own id. A real client
  // reports the latter, so refusing it would leave every round waiting for the
  // full grace period.
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const hostIdentity = room.issue('Host');
  const guestIdentity = room.issue('Guest');
  const hostSocket = socket();
  const guestSocket = socket();
  room.handle(hostSocket, {
    t: 'join',
    ...hostIdentity,
    protocol: 2,
    host: room.hostToken,
    scene: true,
  });
  room.handle(guestSocket, { t: 'join', ...guestIdentity, protocol: 2, scene: true });
  room.handle(hostSocket, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p'], elimination: false },
  });
  room.handle(hostSocket, { t: 'start' });
  expect(room.holeIds[0]).toBe('p');
  expect(room.specs[0].id).toBe('public-level');
  room.handle(hostSocket, {
    t: 'scene',
    matchId: room.matchId,
    holeIndex: 0,
    levelId: room.specs[0].id,
  });
  room.handle(guestSocket, {
    t: 'scene',
    matchId: room.matchId,
    holeIndex: 0,
    levelId: room.specs[0].id,
  });
  await delay(5);
  expect(room.phase).toBe('playing');
  expect(room.snapshot().awaitingPlayers).toBe(0);
  room.dispose();
});

test('a page reload during the countdown has to report its scene again', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const identities = [room.issue('Host'), room.issue('Guest'), room.issue('Third')];
  const hostSocket = socket();
  room.handle(hostSocket, {
    t: 'join',
    ...identities[0],
    protocol: 2,
    host: room.hostToken,
    scene: true,
    instance: 'host-page',
  });
  room.handle(socket(), {
    t: 'join',
    ...identities[1],
    protocol: 2,
    scene: true,
    instance: 'guest-page',
  });
  room.handle(socket(), {
    t: 'join',
    ...identities[2],
    protocol: 2,
    scene: true,
    instance: 'third-page',
  });
  room.handle(hostSocket, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p'], elimination: false },
  });
  room.handle(hostSocket, { t: 'start' });
  const matchId = room.matchId;
  // Two of three clients are loaded; the gate is waiting for the third.
  room.handle(hostSocket, { t: 'scene', matchId, holeIndex: 0 });
  room.handle(room.players.get(identities[1].uid).ws, { t: 'scene', matchId, holeIndex: 0 });
  await delay(30);
  expect(room.phase).toBe('countdown');
  expect(room.snapshot().awaitingPlayers).toBe(1);

  // The loaded second client reloads its page: the prepared scene is gone with
  // the old document, so its fresh document must report again. Otherwise the
  // gate would treat a reloading client as ready and start the round without it.
  const reloaded = socket();
  room.handle(reloaded, {
    t: 'join',
    ...identities[1],
    protocol: 2,
    scene: true,
    instance: 'guest-page-reloaded',
  });
  expect(room.phase).toBe('countdown');
  expect(room.players.get(identities[1].uid).sceneReady).toBe(false);
  expect(room.snapshot().awaitingPlayers).toBe(2);

  // Both fresh documents finish loading, so play starts.
  room.handle(reloaded, { t: 'scene', matchId, holeIndex: 0 });
  room.handle(room.players.get(identities[2].uid).ws, { t: 'scene', matchId, holeIndex: 0 });
  await delay(30);
  expect(room.phase).toBe('playing');
  room.dispose();
});

test('readiness can extend the approved countdown but never shorten it', async () => {
  // A fast client reports its scene before the countdown has elapsed. Play must
  // still wait out the countdown: shortening it would make the visible,
  // approved countdown lie about when input opens.
  const room = new Room('ABCDE', maps, { countdown: 60_000, results: 5 });
  const hostIdentity = room.issue('Host');
  const hostSocket = socket();
  room.handle(hostSocket, {
    t: 'join',
    ...hostIdentity,
    protocol: 2,
    host: room.hostToken,
    scene: true,
  });
  room.handle(hostSocket, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p'], elimination: false },
  });
  room.handle(hostSocket, { t: 'start' });
  const playNotBefore = room.playNotBefore;
  room.handle(hostSocket, { t: 'scene', matchId: room.matchId, holeIndex: 0 });
  await delay(20);
  expect(room.phase).toBe('countdown');
  expect(room.snapshot().awaitingPlayers).toBe(0);
  // The start instant is still the end of the countdown, not the report time.
  expect(room.startsAt).toBe(playNotBefore);
  expect(playNotBefore - Date.now()).toBeGreaterThan(30_000);
  room.dispose();
});

test('host authority transfers in one step and the old token stops working', () => {
  const room = new Room('ABCDE', maps);
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  const previousToken = room.hostToken;
  room.handle(host.ws, {
    t: 'host-action',
    action: 'transfer-host',
    uid: guest.identity.uid,
    matchId: room.matchId,
    holeIndex: 0,
    requestId: 'xfer',
  });
  expect(host.ws.frames.at(-1)).toMatchObject({ t: 'host-ack', requestId: 'xfer', ok: true });
  // Authority moved, the roster says so, and both sides were told.
  expect(room.hostUid).toBe(guest.identity.uid);
  expect(room.roster().map((player) => player.isHost)).toEqual([false, true]);
  expect(host.ws.frames.some((frame) => frame.t === 'host-revoked')).toBe(true);
  expect(guest.ws.frames.find((frame) => frame.t === 'host-granted')).toMatchObject({
    fromUid: host.identity.uid,
  });
  // The capability was rotated and delivered to the new host over its socket.
  expect(room.hostToken).not.toBe(previousToken);
  expect(guest.ws.frames.find((frame) => frame.t === 'host-granted').token).toBe(room.hostToken);
  // The previous host cannot act any more, and its old capability is worthless.
  room.handle(host.ws, { t: 'config', config: { holes: 9 } });
  expect(room.config.holes).toBe(3);
  const staleClaim = socket();
  room.handle(staleClaim, {
    t: 'join',
    ...host.identity,
    protocol: 2,
    host: previousToken,
    instance: 'again',
  });
  expect(room.hostUid).toBe(guest.identity.uid);
  // The new host can act immediately.
  room.handle(guest.ws, { t: 'config', config: { holes: 9 } });
  expect(room.config.holes).toBe(9);
  expect(room.hostTransfer).toMatchObject({
    fromUid: host.identity.uid,
    toUid: guest.identity.uid,
  });
  room.dispose();
});

test('a host hand-over to nobody, or to a disconnected player, is refused', () => {
  const room = new Room('ABCDE', maps);
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  room.close(guest.ws);
  const attempts = [
    { uid: 'missing-uid' },
    { uid: guest.identity.uid },
    { uid: host.identity.uid },
  ];
  for (const [index, attempt] of attempts.entries()) {
    room.handle(host.ws, {
      t: 'host-action',
      action: 'transfer-host',
      ...attempt,
      matchId: room.matchId,
      holeIndex: 0,
      requestId: 'xfer-' + index,
    });
    expect(host.ws.frames.at(-1)).toMatchObject({ t: 'host-ack', ok: false });
  }
  expect(room.hostUid).toBe(host.identity.uid);
  room.dispose();
});

test('a deliberate departure hands the crown to the longest-present player at once', () => {
  const room = new Room('ABCDE', maps);
  const host = enter(room, 'Host', true);
  const first = enter(room, 'First Guest');
  const second = enter(room, 'Second Guest');
  expect(room.hostSuccessionTimer).toBeUndefined();
  room.handle(host.ws, { t: 'leave' });
  expect(host.ws.closed).toBe(true);
  // No grace period: the remaining players are not left without a host.
  expect(room.hostUid).toBe(first.identity.uid);
  expect(room.hostSuccessionTimer).toBeUndefined();
  expect(first.ws.frames.find((frame) => frame.t === 'host-granted')).toBeDefined();
  expect(room.roster().find((player) => player.uid === first.identity.uid).isHost).toBe(true);
  expect(room.roster().some((player) => player.uid === host.identity.uid)).toBe(false);
  expect(room.hostCandidates(room.hostUid).map((player) => player.uid)).toEqual([
    second.identity.uid,
  ]);
  room.dispose();
});

test('an outage waits for the host before the crown moves', () => {
  const room = new Room('ABCDE', maps);
  const host = enter(room, 'Host', true);
  enter(room, 'Guest');
  room.close(host.ws);
  // A dropped connection may be coming back, so authority is held and a timer
  // is armed rather than handed over immediately.
  expect(room.hostUid).toBe(host.identity.uid);
  expect(room.hostSuccessionTimer).toBeDefined();
  room.dispose();
});

test('a host who returns inside the grace period keeps the party', () => {
  const room = new Room('ABCDE', maps);
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  room.close(host.ws);
  expect(room.hostSuccessionTimer).toBeDefined();
  const returning = socket();
  room.handle(returning, {
    t: 'join',
    ...host.identity,
    protocol: 2,
    host: room.hostToken,
    instance: 'again',
  });
  expect(room.hostUid).toBe(host.identity.uid);
  expect(room.hostSuccessionTimer).toBeUndefined();
  expect(guest.ws.frames.some((frame) => frame.t === 'host-granted')).toBe(false);
  room.dispose();
});

test('promotion after the grace period picks the longest-present connected player', () => {
  const room = new Room('ABCDE', maps);
  const host = enter(room, 'Host', true);
  const first = enter(room, 'First Guest');
  const second = enter(room, 'Second Guest');
  room.close(host.ws);
  // The successor is chosen from connected, non-spectating players in join order.
  expect(room.promoteSuccessor()).toBe(first.identity.uid);
  expect(room.hostUid).toBe(first.identity.uid);
  expect(room.hostTransfer).toMatchObject({ toUid: first.identity.uid });
  // The promoted host receives a fresh capability, not the departed one.
  expect(first.ws.frames.find((frame) => frame.t === 'host-granted')).toMatchObject({
    fromUid: host.identity.uid,
    token: room.hostToken,
  });
  room.handle(first.ws, { t: 'config', config: { holes: 7 } });
  expect(room.config.holes).toBe(7);
  expect(room.hostCandidates(room.hostUid).map((player) => player.uid)).toEqual([
    second.identity.uid,
  ]);
  room.dispose();
});

test('a hand-over does not need a round identity and works between rounds', async () => {
  // Host controls are round-scoped, but handing the party over is not: the host
  // must be able to do it in the lobby and on the results screen, where the
  // client has no round to quote.
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  room.handle(host.ws, { t: 'host-action', action: 'transfer-host', uid: guest.identity.uid });
  expect(room.hostUid).toBe(guest.identity.uid);
  room.dispose();
});

test('a player is preferred to a spectator, who is a last resort rather than nobody', () => {
  // Losing the last player in an elimination round must not leave the party
  // hostless, but a watching player must never outrank a playing one.
  const room = new Room('ABCDE', maps);
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  const spectator = enter(room, 'Watcher');
  room.players.get(spectator.identity.uid).role = 'spectator';
  expect(room.hostCandidates(host.identity.uid).map((player) => player.uid)).toEqual([
    guest.identity.uid,
  ]);
  // With no players left the spectator is the only candidate, so the party
  // still has somebody who can hand the crown on.
  room.close(guest.ws);
  expect(room.hostCandidates(host.identity.uid).map((player) => player.uid)).toEqual([
    spectator.identity.uid,
  ]);
  room.handle(host.ws, { t: 'leave' });
  expect(room.hostUid).toBe(spectator.identity.uid);
  room.dispose();
});

test('a completion from the finished attempt cannot score the restarted one', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p'], elimination: false },
  });
  room.handle(host.ws, { t: 'start' });
  await delay(12);
  const firstMatch = room.matchId;
  room.handle(host.ws, { f: 1, s: 2, p: 3, matchId: firstMatch, holeIndex: 0 });
  room.handle(host.ws, {
    t: 'host-action',
    action: 'restart',
    matchId: firstMatch,
    holeIndex: 0,
  });
  expect(room.matchId).not.toBe(firstMatch);
  expect(room.phase).toBe('countdown');
  // Let the restarted countdown finish so the round is genuinely playable: the
  // only thing that can still reject the stale packet is its round identity.
  await delay(12);
  expect(room.phase).toBe('playing');
  // A client that had already holed out replays its completion for the previous
  // attempt. The restarted hole has not been played, so this must be ignored:
  // otherwise the stale result would score the new attempt before it begins.
  room.handle(guest.ws, { f: 1, s: 1, p: 3, matchId: firstMatch, holeIndex: 0 });
  expect(guest.player.done).toBe(false);
  expect(guest.player.strokes).toBe(0);
  expect(guest.player.success).toBe(false);
  // The current attempt is still accepted.
  room.handle(guest.ws, { f: 1, s: 4, p: 3, matchId: room.matchId, holeIndex: 0 });
  expect(guest.player.done).toBe(true);
  expect(guest.player.strokes).toBe(4);
  room.dispose();
});

test('late join policy is host-only, validated and restored with backward-compatible defaults', () => {
  const room = new Room('ABCDE', maps);
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  expect(room.config.lateJoin).toBe('always');
  room.handle(guest.ws, { t: 'config', config: { lateJoin: 'never' } });
  expect(room.config.lateJoin).toBe('always');
  room.handle(host.ws, { t: 'config', config: { lateJoin: 'invalid' } });
  expect(room.config.lateJoin).toBe('always');
  room.handle(host.ws, { t: 'config', config: { lateJoin: 'next-hole' } });
  expect(room.config.lateJoin).toBe('next-hole');
  room.handle(host.ws, { t: 'config', config: { timerMs: 40000 } });
  expect(room.config.lateJoin).toBe('next-hole');
  const checkpoint = room.checkpoint();
  expect(checkpoint.config.lateJoin).toBe('next-hole');
  const restored = new Room('ABCDE', maps);
  restored.restore(checkpoint);
  expect(restored.config.lateJoin).toBe('next-hole');
  delete checkpoint.config.lateJoin;
  restored.restore(checkpoint);
  expect(restored.config.lateJoin).toBe('never');
  restored.dispose();
  room.dispose();
});

test('next-hole late arrivals spectate through a restart and enter only the following hole', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  try {
    const host = enter(room, 'Host', true);
    room.handle(host.ws, {
      t: 'config',
      config: {
        lateJoin: 'next-hole',
        elimination: false,
        mapSource: 'picked',
        selectedHoleIds: ['p', 'q'],
      },
    });
    room.handle(host.ws, { t: 'start' });
    await waitForRoom(() => room.phase === 'playing');
    const late = enter(room, 'Late');
    expect(late.player.role).toBe('spectator');
    expect(room.roster().find((player) => player.uid === late.identity.uid).spectatorReason).toBe(
      'next-hole',
    );
    room.handle(late.ws, { t: 'prog', st: 9 });
    room.handle(late.ws, { f: 1, s: 1, p: 3 });
    expect(late.player.strokes).toBe(0);
    expect(room.standings()).toHaveLength(1);
    room.handle(host.ws, {
      t: 'host-action',
      action: 'restart',
      matchId: room.matchId,
      holeIndex: room.holeIndex,
    });
    expect(late.player.role).toBe('spectator');
    await waitForRoom(() => room.phase === 'playing');
    room.handle(host.ws, { f: 1, s: 2, p: 3 });
    await waitForRoom(() => room.holeIndex === 1 && room.phase === 'playing');
    expect(late.player.role).toBe('player');
    expect(room.initialPlayers).toBe(2);
    expect(room.roundHistory[0].rows).toEqual([
      { uid: host.identity.uid, strokes: 2, status: 'holed', timeMs: expect.any(Number) },
    ]);
    expect(late.player.totalStrokes).toBe(0);
    expect(late.player.holesSurvived).toBe(0);
    room.handle(late.ws, { f: 1, s: 1, p: 2 });
    room.handle(host.ws, { f: 1, s: 3, p: 2 });
    await waitForRoom(() => room.phase === 'final');
    expect(room.standings().map((player) => player.uid)).toEqual([
      host.identity.uid,
      late.identity.uid,
    ]);
    expect(late.player.totalStrokes).toBe(1);
  } finally {
    room.dispose();
  }
});

test('always admits newcomers immediately without resetting the clock or allowing reentry exploits', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  try {
    const host = enter(room, 'Host', true);
    room.handle(host.ws, {
      t: 'config',
      config: {
        elimination: false,
        mapSource: 'picked',
        selectedHoleIds: ['p', 'q'],
      },
    });
    room.handle(host.ws, { t: 'start' });
    await waitForRoom(() => room.phase === 'playing');
    const started = room.startsAt;
    const late = enter(room, 'Late');
    expect(late.player.role).toBe('player');
    expect(late.player.participated).toBe(true);
    expect(room.startsAt).toBe(started);
    expect(room.board().alive).toBe(2);
    expect(host.ws.frames.filter((frame) => frame.t === 'party').at(-1).initialPlayers).toBe(2);
    room.handle(late.ws, { t: 'prog', st: 1 });
    expect(late.player.strokes).toBe(1);
    // A deliberate departure does not turn the same identity into a newcomer.
    room.handle(late.ws, { t: 'leave' });
    const again = socket();
    room.handle(again, { t: 'join', ...late.identity, protocol: 2 });
    expect(room.players.get(late.identity.uid).role).toBe('spectator');
    expect(room.board().alive).toBe(1);
    room.handle(host.ws, { f: 1, s: 2, p: 3 });
    const duringResults = enter(room, 'Results joiner');
    expect(duringResults.player.role).toBe('spectator');
    await waitForRoom(() => room.phase === 'playing' && room.holeIndex === 1);
    expect(duringResults.player.role).toBe('player');
    expect(room.players.get(late.identity.uid).role).toBe('spectator');
    expect(room.roundHistory[0].rows.every((row) => row.uid !== duringResults.identity.uid)).toBe(
      true,
    );
  } finally {
    room.dispose();
  }
});

test('never keeps a newcomer spectating until rematch even as holes advance', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  try {
    const host = enter(room, 'Host', true);
    room.handle(host.ws, {
      t: 'config',
      config: { elimination: false, mapSource: 'picked', selectedHoleIds: ['p', 'q'] },
    });
    room.handle(host.ws, { t: 'config', config: { lateJoin: 'never' } });
    room.handle(host.ws, { t: 'start' });
    await waitForRoom(() => room.phase === 'playing');
    const late = enter(room, 'Late');
    expect(room.spectatorReason(late.player)).toBe('next-match');
    room.handle(host.ws, { f: 1, s: 1, p: 3 });
    await waitForRoom(() => room.phase === 'playing' && room.holeIndex === 1);
    expect(late.player.role).toBe('spectator');
    room.handle(host.ws, { f: 1, s: 1, p: 2 });
    await waitForRoom(() => room.phase === 'final');
    room.handle(host.ws, { t: 'rematch' });
    expect(late.player.role).toBe('player');
  } finally {
    room.dispose();
  }
});

test('server-recorded hole times break equal stroke totals, not primary stroke or survival ranking', async () => {
  const room = new Room('ABCDE', maps, { countdown: 1, results: 1 });
  try {
    const slower = enter(room, 'Alpha', true);
    const faster = enter(room, 'Zulu');
    const moreStrokes = enter(room, 'Beta');
    room.handle(slower.ws, {
      t: 'config',
      config: { mapSource: 'picked', selectedHoleIds: ['p', 'q'], elimination: false },
    });
    room.handle(slower.ws, { t: 'start' });
    await waitForRoom(() => room.phase === 'playing');
    // Server time only; ignore a client-supplied time.
    room.startsAt = Date.now() - 1000;
    room.handle(moreStrokes.ws, { f: 1, s: 3, p: 3, timeMs: 0 });
    room.startsAt -= 1000;
    room.handle(faster.ws, { f: 1, s: 2, p: 3, timeMs: 0 });
    const finish = faster.player.holeTimeMs;
    expect(finish).toBeGreaterThanOrEqual(2000);
    room.startsAt -= 1000;
    room.handle(slower.ws, { f: 1, s: 2, p: 3 });
    expect(room.roundHistory[0].rows.find((row) => row.uid === faster.identity.uid).timeMs).toBe(
      finish,
    );
    expect(room.standings().map((row) => row.uid)).toEqual([
      faster.identity.uid,
      slower.identity.uid,
      moreStrokes.identity.uid,
    ]);
    await waitForRoom(() => room.phase === 'playing' && room.holeIndex === 1);
    expect(faster.player.holeTimeMs).toBeUndefined();
    expect(faster.player.totalTimeMs).toBe(finish);
    room.startsAt = Date.now() - 5000;
    room.handle(faster.ws, { f: 1, s: 1, p: 2 });
    room.handle(slower.ws, {
      t: 'host-action',
      action: 'restart',
      matchId: room.matchId,
      holeIndex: room.holeIndex,
    });
    expect(faster.player.holeTimeMs).toBeUndefined();
    expect(faster.player.totalTimeMs).toBe(finish);
    await waitForRoom(() => room.phase === 'playing');
    room.handle(faster.ws, { t: 'forfeit' });
    room.handle(slower.ws, { f: 1, s: 2, p: 2 });
    room.handle(moreStrokes.ws, { f: 1, s: 2, p: 2 });
    await waitForRoom(() => room.phase === 'final');
    expect(faster.player.totalTimeMs).toBe(finish + room.roundTimerMs);
    expect(room.roundHistory[1].rows.find((row) => row.uid === faster.identity.uid)).toMatchObject({
      status: 'timeout',
      timeMs: room.roundTimerMs,
    });
    expect(room.standings()[0].uid).toBe(slower.identity.uid);
  } finally {
    room.dispose();
  }
});

const votingCourse = (id) => ({
  id,
  title: id,
  author: 'Maker',
  ratingAvg: 4.5,
  ratingCount: 8,
  par: 3,
  spec: { ...spec, id, name: id },
});
const votingBallots = [
  ['first-a', 'first-b', 'first-c'].map(votingCourse),
  ['option-a', 'option-b', 'option-c'].map(votingCourse),
  ['option-d', 'option-e', 'option-f'].map(votingCourse),
];
function votingRoom() {
  return new Room('ABCDE', maps, {
    countdown: 1,
    results: 1,
    votingMs: 1000,
    prepareMatch: async (config) => {
      const ballots = structuredClone(votingBallots.slice(0, config.holes));
      return {
        ids: ballots.map((choices) => choices[0].id),
        specs: ballots.map((choices) => choices[0].spec),
        ballots,
      };
    },
  });
}

test('optional course voting accepts one revisable vote per connected identity, rejects invalid/stale ballots, loads winner and resets timing', async () => {
  const room = votingRoom();
  try {
    const host = enter(room, 'Host', true);
    const guest = enter(room, 'Guest');
    expect(room.config.courseVoting).toBe(false);
    room.handle(guest.ws, { t: 'config', config: { courseVoting: true } });
    expect(room.config.courseVoting).toBe(false);
    room.handle(host.ws, {
      t: 'config',
      config: { courseVoting: true, holes: 3, elimination: false },
    });
    expect(room.config.courseVoting).toBe(true);
    room.handle(host.ws, { t: 'start' });
    await waitForRoom(() => room.vote?.target === 0);
    expect(room.snapshot().currentMap).toBeNull();
    expect(room.roundHistory).toEqual([]);
    expect(room.snapshot().vote.choices.map((choice) => choice.id)).toEqual([
      'first-a',
      'first-b',
      'first-c',
    ]);
    const firstVoteId = room.vote.id;
    room.handle(host.ws, { f: 1, s: 1, p: 3 });
    expect(host.player.done).toBe(false);
    room.handle(host.ws, { t: 'course-vote', voteId: firstVoteId, courseId: 'first-c' });
    room.resolveVote();
    await waitForRoom(() => room.phase === 'playing');
    expect(room.holeIds[0]).toBe('first-c');
    expect(room.snapshot().currentMap.id).toBe('first-c');
    room.handle(host.ws, { f: 1, s: 1, p: 3 });
    room.handle(guest.ws, { f: 1, s: 2, p: 3 });
    await waitForRoom(() => !!room.vote);
    const voteId = room.vote.id;
    const cast = (player, courseId, id = voteId) =>
      room.handle(player.ws, { t: 'course-vote', voteId: id, courseId });
    expect(room.snapshot().vote.choices.map((choice) => choice.id)).toEqual([
      'option-a',
      'option-b',
      'option-c',
    ]);
    expect(room.snapshot().vote.choices[0]).toMatchObject({ ratingAvg: 4.5, par: 3, votes: 0 });
    cast(host, 'option-b', 'old');
    cast(host, 'not-an-option');
    expect(room.voteSnapshot().ballots).toEqual({});
    cast(host, 'option-a');
    cast(host, 'option-b');
    cast(host, 'option-b');
    cast(guest, 'option-b');
    expect(room.voteSnapshot().choices.map((choice) => choice.votes)).toEqual([0, 2, 0]);
    const late = enter(room, 'Late');
    cast(late, 'option-c');
    room.close(late.ws);
    expect(room.voteSnapshot().choices.map((choice) => choice.votes)).toEqual([0, 2, 0]);
    expect(
      host.ws.frames.some(
        (frame) => frame.t === 'course-vote' && frame.vote.choices[1].votes === 2,
      ),
    ).toBe(true);
    room.resolveVote();
    await waitForRoom(() => room.phase === 'playing' && room.holeIndex === 1);
    expect(room.holeIds[1]).toBe('option-b');
    expect(room.snapshot().currentMap.id).toBe('option-b');
    expect(room.vote).toBeNull();
    expect(host.player.holeTimeMs).toBeUndefined();
    expect(room.roundHistory[0].rows).toHaveLength(2);
    room.handle(host.ws, { f: 1, s: 1, p: 3 });
    room.handle(guest.ws, { f: 1, s: 2, p: 3 });
    await waitForRoom(() => !!room.vote);
    cast(host, 'option-d', voteId);
    expect(room.voteSnapshot().ballots).toEqual({});
    // No votes: uniformly choose from the valid options.
    room.resolveVote();
    expect(['option-d', 'option-e', 'option-f']).toContain(room.holeIds[2]);
    expect(room.snapshot().vote).toBeNull();
  } finally {
    room.dispose();
  }
});

test('manual playlists disable course voting and saved randomized voting recovers', () => {
  const room = new Room('ABCDE', maps);
  const restored = new Room('ABCDE', maps);
  try {
    const host = enter(room, 'Host', true);
    room.handle(host.ws, { t: 'config', config: { courseVoting: true } });
    restored.restore(room.checkpoint());
    expect(restored.config.courseVoting).toBe(true);
    room.handle(host.ws, { t: 'config', config: { mapSource: 'picked', selectedHoleIds: ['p'] } });
    expect(room.config.courseVoting).toBe(false);
  } finally {
    room.dispose();
    restored.dispose();
  }
});

test('a one-hole voting party votes before play, admits an opening voter even if late joining is disabled, and ends normally', async () => {
  const room = votingRoom();
  try {
    const host = enter(room, 'Host', true);
    room.handle(host.ws, {
      t: 'config',
      config: { courseVoting: true, holes: 1, lateJoin: 'never', elimination: false },
    });
    room.handle(host.ws, { t: 'start' });
    await waitForRoom(() => room.vote?.target === 0);
    const guest = enter(room, 'Opening guest');
    expect(guest.player.role).toBe('player');
    expect(room.initialPlayers).toBe(2);
    room.handle(guest.ws, { t: 'course-vote', voteId: room.vote.id, courseId: 'first-b' });
    room.resolveVote();
    await waitForRoom(() => room.phase === 'playing');
    expect(room.holeIds).toEqual(['first-b']);
    expect(room.vote).toBeNull();
    expect(room.roundHistory).toEqual([]);
    room.handle(host.ws, { f: 1, s: 2, p: 3 });
    room.handle(guest.ws, { f: 1, s: 1, p: 3 });
    await waitForRoom(() => room.phase === 'final');
    expect(room.roundHistory).toHaveLength(1);
    expect(room.roundHistory[0].id).toBe('first-b');
  } finally {
    room.dispose();
  }
});

/**
 * The reconnect matrix: a disconnect in every phase, not just the ones that
 * happened to get a test. Each phase has a different thing that must survive,
 * so a single "reconnect works" test would not show it. The host is used for
 * the lobby and countdown cases because the crown must survive with it, and a
 * player for the phases where the party has already started.
 */
test('a reconnect in the lobby keeps the identity and the host crown', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const host = enter(room, 'Host', true);
  room.handle(host.ws, { t: 'config', config: { maxPlayers: 4 } });
  expect(room.phase).toBe('lobby');
  room.close(host.ws);
  expect(room.players.get(host.identity.uid).ws).toBe(null);
  const again = socket();
  room.handle(again, {
    t: 'join',
    ...host.identity,
    protocol: 2,
    host: room.hostToken,
    instance: 'again',
  });
  expect(room.phase).toBe('lobby');
  expect(room.hostUid).toBe(host.identity.uid);
  expect(room.players.get(host.identity.uid).ws).toBe(again);
  // The configuration is the party's, not the connection's.
  expect(room.config.maxPlayers).toBe(4);
  expect(again.frames.some((frame) => frame.t === 'hello' && frame.isHost === true)).toBe(true);
  expect(again.frames.some((frame) => frame.t === 'party' && frame.phase === 'lobby')).toBe(true);
  room.dispose();
});

test('a reconnect in the countdown keeps the match and the hole index', async () => {
  const room = new Room('ABCDE', maps, { countdown: 40, results: 5 });
  const host = enter(room, 'Host', true);
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q'], elimination: false },
  });
  room.handle(host.ws, { t: 'start' });
  const matchId = room.matchId;
  expect(room.phase).toBe('countdown');
  // A player whose page dropped mid-countdown is still in the match; the party
  // must not restart, re-prepare or renumber the hole around the reconnect.
  const guest = enter(room, 'Guest');
  room.close(guest.ws);
  const again = socket();
  room.handle(again, {
    t: 'join',
    ...guest.identity,
    protocol: 2,
    instance: 'again',
  });
  expect(room.phase).toBe('countdown');
  expect(room.matchId).toBe(matchId);
  expect(room.holeIndex).toBe(0);
  expect(room.players.get(guest.identity.uid).ws).toBe(again);
  expect(again.frames.some((frame) => frame.t === 'party' && frame.matchId === matchId)).toBe(true);
  room.dispose();
});

test('a reconnect while the previous hole is being scored stays in scoring', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 40 });
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q'], elimination: false },
  });
  room.handle(host.ws, { t: 'start' });
  await waitForRoom(() => room.phase === 'playing');
  const matchId = room.matchId;
  room.handle(host.ws, { f: 1, s: 2, p: 3 });
  room.handle(guest.ws, { f: 1, s: 2, p: 3 });
  expect(room.phase).toBe('hole-results');
  room.close(guest.ws);
  const again = socket();
  room.handle(again, {
    t: 'join',
    ...guest.identity,
    protocol: 2,
    instance: 'again',
  });
  // Scoring is not a round to replay: the hole is settled for this player.
  expect(room.phase).toBe('hole-results');
  expect(room.holeIndex).toBe(0);
  expect(room.matchId).toBe(matchId);
  expect(again.frames.some((frame) => frame.t === 'party' && frame.phase === 'hole-results')).toBe(
    true,
  );
  // No replayed completion and no progress claim from the fresh document.
  expect(again.frames.some((frame) => frame.f === 1)).toBe(false);
  room.dispose();
});

test('a reconnect after the party ends is re-sent the final standings', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p'], elimination: false },
  });
  room.handle(host.ws, { t: 'start' });
  await waitForRoom(() => room.phase === 'playing');
  room.handle(host.ws, { f: 1, s: 2, p: 3 });
  room.handle(guest.ws, { f: 1, s: 3, p: 3 });
  await waitForRoom(() => room.phase === 'final');
  const uid = guest.identity.uid;
  // Final standings go to everybody, and a late socket must not have to ask.
  room.close(guest.ws);
  const again = socket();
  room.handle(again, {
    t: 'join',
    ...guest.identity,
    protocol: 2,
    instance: 'again',
  });
  expect(room.phase).toBe('final');
  const final = again.frames.find((frame) => frame.t === 'final');
  expect(final).toBeTruthy();
  expect(final.standings).toHaveLength(2);
  expect(final.standings.map((row) => row.uid)).toContain(uid);
  room.dispose();
});

test('closing the only connection keeps a spectator out of the roster', async () => {
  // A socket that simply goes away must not leave a ghost the party still
  // counts. The lobby drops it outright; after the start the identities that
  // were never admitted are dropped the same way.
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  enter(room, 'Host', true);
  const watcher = enter(room, 'Watcher');
  expect(room.roster()).toHaveLength(2);
  room.close(watcher.ws);
  expect(room.roster()).toHaveLength(1);
  expect(room.players.has(watcher.identity.uid)).toBe(false);
  room.dispose();
});

test('simultaneous joins for the last slot admit exactly one and refuse the rest', () => {
  // Two identities are issued while the room still has room, then both sockets
  // join before either handler finishes. The slot count is read from the live
  // roster, so the first join takes the last place and every later join is
  // refused — issuing credentials early must not oversubscribe the room.
  const room = new Room('ABCDE', maps);
  enter(room, 'Host', true);
  room.handle([...room.players.values()].find((player) => player.uid === room.hostUid).ws, {
    t: 'config',
    config: { maxPlayers: 2 },
  });
  expect(room.config.maxPlayers).toBe(2);
  const first = room.issue('Racer One');
  const second = room.issue('Racer Two');
  const firstSocket = socket();
  const secondSocket = socket();
  // Interleave the two joins rather than one after the other.
  room.handle(firstSocket, { t: 'join', ...first, protocol: 2, instance: 'race-one' });
  room.handle(secondSocket, { t: 'join', ...second, protocol: 2, instance: 'race-two' });
  const admitted = [firstSocket, secondSocket].filter(
    (candidate) => !candidate.closed && candidate.frames.some((frame) => frame.t === 'hello'),
  );
  const refused = [firstSocket, secondSocket].filter((candidate) => candidate.closed === true);
  expect(admitted).toHaveLength(1);
  expect(refused).toHaveLength(1);
  expect(refused[0].frames.some((frame) => frame.t === 'error' && frame.code === 'full')).toBe(
    true,
  );
  // The roster agrees with the sockets: exactly host plus one racer.
  expect([...room.players.values()].filter((player) => player.ws)).toHaveLength(2);
  expect(room.roster()).toHaveLength(2);
  room.dispose();
});

test('a locked party refuses to issue new identities but keeps the ones already admitted', () => {
  const room = new Room('ABCDE', maps);
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  room.handle(host.ws, { t: 'config', config: { locked: true } });
  expect(room.config.locked).toBe(true);
  // The lock is enforced when a credential would be issued, which is the only
  // point an outsider could become a player at all.
  expect(() => room.issue('Outsider')).toThrow(/locked/);
  // The guest already in the party is unaffected, and reconnecting still works:
  // the lock is about admission, not about the players it was set for.
  room.close(guest.ws);
  const again = socket();
  room.handle(again, { t: 'join', ...guest.identity, protocol: 2, instance: 'again' });
  expect(again.closed).toBeUndefined();
  expect(again.frames.some((frame) => frame.t === 'hello')).toBe(true);
  expect(room.roster()).toHaveLength(2);
  room.dispose();
});
