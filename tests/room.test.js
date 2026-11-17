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
  send(s) {
    this.frames.push(JSON.parse(s));
  },
  close() {
    this.closed = true;
  },
});
const enter = (room, name, host = false) => {
  const j = room.issue(name),
    ws = socket();
  room.handle(ws, { t: 'join', ...j, protocol: 2, ...(host ? { host: room.hostToken } : {}) });
  return { ws, j, p: room.players.get(j.uid) };
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
test('only independently issued identity may join; admin is token bound', () => {
  const r = new Room('ABCDE', maps),
    bad = socket();
  r.handle(bad, { t: 'join', uid: 'arbitrary', name: 'fake', protocol: 2 });
  expect(bad.closed).toBe(true);
  const h = enter(r, 'Host', true),
    g = enter(r, 'Guest');
  expect(r.roster().map((x) => x.isHost)).toEqual([true, false]);
  r.handle(g.ws, { t: 'config', config: { holes: 9 } });
  expect(r.config.holes).toBe(3);
  r.handle(g.ws, { t: 'start' });
  expect(r.phase).toBe('lobby');
  expect(h.ws.frames.some((f) => f.t === 'hello' && f.isHost)).toBe(true);
  expect(g.ws.frames.some((f) => f.t === 'error')).toBe(true);
  r.dispose();
});
test('ready and roster; partial config retains values; duplicate playlist IDs accepted', () => {
  const r = new Room('ABCDE', maps),
    h = enter(r, 'Host', true),
    g = enter(r, 'Guest');
  r.handle(g.ws, { t: 'ready', v: true });
  expect(r.roster().find((p) => p.uid === g.j.uid).ready).toBe(true);
  r.handle(h.ws, {
    t: 'config',
    config: {
      mapSource: 'picked',
      selectedHoleIds: ['p', 'p'],
      timerMs: 20000,
      elimination: false,
    },
  });
  expect(r.config).toMatchObject({
    mapSource: 'picked',
    holes: 2,
    selectedHoleIds: ['p', 'p'],
    timerMs: 20000,
    elimination: false,
    maxPlayers: 50,
  });
  r.handle(h.ws, { t: 'config', config: { selectedHoleIds: ['missing'] } });
  expect(r.config.selectedHoleIds).toEqual(['p', 'p']);
  r.dispose();
});
test('two rounds: immutable map, real protocol shapes, idempotent completion, final and rematch', async () => {
  const r = new Room('ABCDE', maps, { countdown: 5, results: 5 }),
    h = enter(r, 'Host', true),
    g = enter(r, 'Guest');
  r.handle(h.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q'], elimination: false },
  });
  r.handle(h.ws, { t: 'start' });
  expect(r.phase).toBe('countdown');
  expect(r.snapshot().currentMap.id).toBe('public-level');
  const id = r.matchId;
  r.handle(h.ws, { f: 1, s: 1, p: 3 });
  expect(h.p.done).toBe(false);
  await delay(12);
  expect(r.phase).toBe('playing');
  r.handle(h.ws, { t: 'prog', st: 2 });
  expect(h.p.strokes).toBe(2);
  r.handle(h.ws, { f: 1, s: 1, p: 3 });
  expect(h.p.done).toBe(false);
  r.handle(h.ws, { f: 1, s: 2, p: 3 });
  expect(h.p.done).toBe(true);
  r.handle(h.ws, { f: 1, s: 3, p: 3 });
  expect(h.p.strokes).toBe(2);
  r.handle(g.ws, { f: 1, s: 3, p: 3 });
  expect(r.phase).toBe('hole-results');
  await delay(20);
  expect(r.phase).toBe('playing');
  expect(r.holeIndex).toBe(1);
  expect(r.matchId).toBe(id);
  expect(r.snapshot().currentMap.id).toBe('next');
  r.handle(g.ws, { t: 'forfeit' });
  r.handle(h.ws, { f: 1, s: 1, p: 2 });
  await delay(15);
  expect(r.phase).toBe('final');
  expect(r.standings()[0].uid).toBe(h.j.uid);
  expect(h.ws.frames.some((m) => m.t === 'final')).toBe(true);
  r.handle(h.ws, { t: 'rematch' });
  expect(r.phase).toBe('lobby');
  expect(r.matchId).toBe(null);
  expect(r.snapshot().holeIds).toEqual([]);
  r.dispose();
});
test('connect and disconnect preserve identity and remove ghost; late join spectators', () => {
  const r = new Room('ABCDE', maps, { countdown: 10000 }),
    h = enter(r, 'Host', true),
    g = enter(r, 'Guest');
  r.handle(h.ws, { t: 'start' });
  const late = enter(r, 'Late');
  expect(late.p.role).toBe('spectator');
  r.close(g.ws);
  expect(h.ws.frames.some((f) => f.t === 'bye' && f.id === g.p.id)).toBe(true);
  const old = g.p.id,
    ws = socket();
  r.handle(ws, { t: 'join', ...g.j, protocol: 2 });
  expect(r.players.get(g.j.uid).id).not.toBe(old);
  expect(ws.frames.find((f) => f.t === 'party').matchId).toBe(r.matchId);
  r.dispose();
});
test('presence relays by server socket ID and rejects invalid numbers', () => {
  const r = new Room('ABCDE', maps, { countdown: 1000 }),
    h = enter(r, 'Host', true),
    g = enter(r, 'Guest');
  r.handle(h.ws, { t: 'start' });
  r.handle(g.ws, { x: 1, y: 2, z: 3, px: 0, pz: 0, c: 1, m: 1, d: 4, id: 'forged-id' });
  r.tick();
  expect(h.ws.frames.at(-1)).toMatchObject({
    t: 'b',
    s: [{ id: g.p.id, x: 1, y: 2, z: 3, c: 1, m: 1 }],
  });
  r.handle(g.ws, { x: Infinity, y: 2, z: 3, px: 0, pz: 0, c: 1, m: 1 });
  expect(r.positions.size).toBe(0);
  r.dispose();
});
test('roster-visible UID is not a reconnect credential; secret is never published', () => {
  const r = new Room('ABCDE', maps),
    h = enter(r, 'Host', true),
    g = enter(r, 'Guest');
  expect(h.j.uid).not.toBe(h.j.session);
  const impersonator = socket();
  r.handle(impersonator, { t: 'join', uid: h.j.uid, protocol: 2 });
  expect(impersonator.closed).toBe(true);
  expect(r.players.get(h.j.uid).ws).toBe(h.ws);
  expect(() => r.issue('Host', h.j.uid, 'wrong-secret')).toThrow();
  expect(r.issue('Host', h.j.uid, h.j.session)).toEqual(h.j);
  expect(JSON.stringify(g.ws.frames)).not.toContain(h.j.session);
  expect(JSON.stringify(h.ws.frames)).not.toContain(g.j.session);
  r.dispose();
});
test('elimination advances all successful players and rejects non-finishers', async () => {
  const r = new Room('ABCDE', maps, { countdown: 5, results: 5 }),
    h = enter(r, 'H', true),
    g = enter(r, 'G'),
    k = enter(r, 'K');
  r.handle(h.ws, { t: 'config', config: { mapSource: 'picked', selectedHoleIds: ['p', 'q'] } });
  r.handle(h.ws, { t: 'start' });
  await delay(10);
  r.handle(h.ws, { f: 1, s: 1, p: 3 });
  r.handle(g.ws, { f: 1, s: 4, p: 3 });
  r.handle(k.ws, { t: 'forfeit' });
  expect(r.phase).toBe('hole-results');
  expect(h.p.alive).toBe(true);
  expect(g.p.alive).toBe(true);
  expect(k.p.alive).toBe(false);
  expect(k.p.holesSurvived).toBe(0);
  expect(k.p.role).toBe('spectator');
  await delay(20);
  expect(r.phase).toBe('playing');
  expect(r.holeIndex).toBe(1);
  expect(r.board().alive).toBe(2);
  r.dispose();
});
test('a full reload during play cannot reset progress; ordinary reconnect preserves progress', async () => {
  const r = new Room('ABCDE', maps, { countdown: 5, results: 5 }),
    h = enter(r, 'Host', true);
  const j = r.issue('Guest'),
    ws = socket();
  r.handle(ws, { t: 'join', ...j, instance: 'page1', protocol: 2 });
  r.handle(h.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q'], elimination: false },
  });
  r.handle(h.ws, { t: 'start' });
  await delay(10);
  r.handle(ws, { t: 'prog', st: 4 });
  r.close(ws);
  const reconnect = socket();
  r.handle(reconnect, { t: 'join', ...j, instance: 'page1', protocol: 2 });
  const p = r.players.get(j.uid);
  expect(p.strokes).toBe(4);
  expect(p.done).toBe(false);
  const reload = socket();
  r.handle(reload, { t: 'join', ...j, instance: 'page2', protocol: 2 });
  expect(p.role).toBe('spectator');
  expect(p.done).toBe(true);
  expect(p.strokes).toBe(4);
  r.handle(h.ws, { f: 1, s: 2, p: 3 });
  await delay(20);
  expect(r.holeIndex).toBe(1);
  expect(p.role).toBe('player');
  expect(p.strokes).toBe(0);
  expect(p.done).toBe(false);
  r.dispose();
});
test('asynchronous map preparation locks configuration and rolls back on failure', async () => {
  let reject;
  const r = new Room('ABCDE', maps, { prepareMatch: () => new Promise((_, r) => (reject = r)) }),
    h = enter(r, 'Host', true);
  r.handle(h.ws, { t: 'start' });
  await delay(1);
  expect(r.snapshot().preparing).toBe(true);
  r.handle(h.ws, { t: 'config', config: { holes: 9 } });
  expect(r.config.holes).toBe(3);
  reject(Error('upstream unavailable'));
  await delay(1);
  expect(r.snapshot().preparing).toBe(false);
  expect(r.phase).toBe('lobby');
  expect(h.ws.frames.some((m) => m.code === 'map-load-failed')).toBe(true);
  r.dispose();
});
test('progress can return to zero when the original client resets its first shot', async () => {
  const r = new Room('ABCDE', maps, { countdown: 5 }),
    h = enter(r, 'Host', true);
  r.handle(h.ws, { t: 'start' });
  await delay(10);
  r.handle(h.ws, { t: 'prog', st: 1 });
  r.handle(h.ws, { t: 'prog', st: 0 });
  expect(h.p.strokes).toBe(0);
  r.dispose();
});

test('host timer extensions are authoritative and do not affect next hole', async () => {
  const r = new Room('ABCDE', maps, { countdown: 5, results: 5 }),
    h = enter(r, 'Host', true),
    g = enter(r, 'Guest');
  r.handle(h.ws, {
    t: 'config',
    config: {
      mapSource: 'picked',
      selectedHoleIds: ['p', 'q'],
      elimination: false,
      timerMs: 20000,
    },
  });
  r.handle(h.ws, { t: 'start' });
  await delay(12);
  const action = {
    t: 'host-action',
    action: 'time',
    seconds: 30,
    matchId: r.matchId,
    holeIndex: 0,
  };
  r.handle(g.ws, action);
  expect(r.snapshot().timerMs).toBe(20000);
  expect(g.ws.frames.at(-1).code).toBe('not-host');
  r.handle(h.ws, { ...action, seconds: -1 });
  expect(r.snapshot().timerMs).toBe(20000);
  r.handle(h.ws, action);
  expect(r.snapshot().timerMs).toBe(50000);
  expect(r.config.timerMs).toBe(20000);
  expect(g.ws.frames.at(-1).timerMs).toBe(50000);
  r.handle(h.ws, { ...action, holeIndex: 1 });
  expect(r.snapshot().timerMs).toBe(50000);
  r.handle(h.ws, { f: 1, s: 1, p: 3 });
  r.handle(g.ws, { f: 1, s: 2, p: 3 });
  await delay(20);
  expect(r.holeIndex).toBe(1);
  expect(r.snapshot().timerMs).toBe(20000);
  r.dispose();
});
test('host skip voids a round without score or eliminations; restart retains prior rounds; end shows final', async () => {
  const r = new Room('ABCDE', maps, { countdown: 5, results: 5 }),
    h = enter(r, 'Host', true),
    g = enter(r, 'Guest');
  r.handle(h.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q', 'p'], elimination: false },
  });
  r.handle(h.ws, { t: 'start' });
  await delay(10);
  r.handle(h.ws, { f: 1, s: 2, p: 3 });
  r.handle(g.ws, { f: 1, s: 4, p: 3 });
  await delay(20);
  const action = (name) => ({
    t: 'host-action',
    action: name,
    matchId: r.matchId,
    holeIndex: r.holeIndex,
  });
  r.handle(h.ws, { t: 'prog', st: 3 });
  const old = r.matchId;
  r.handle(h.ws, action('restart'));
  expect(r.matchId).not.toBe(old);
  expect(r.holeIndex).toBe(1);
  expect(h.p.strokes).toBe(0);
  expect(h.p.totalStrokes).toBe(2);
  const stale = action('skip');
  r.handle(h.ws, stale);
  expect(r.holeIndex).toBe(2);
  expect(h.p.totalStrokes).toBe(2);
  expect(g.p.alive).toBe(true);
  r.handle(h.ws, stale);
  expect(r.holeIndex).toBe(2);
  r.handle(h.ws, action('end'));
  expect(r.phase).toBe('final');
  expect(h.p.holesSurvived).toBe(1);
  expect(g.ws.frames.at(-1).t).toBe('final');
  r.handle(h.ws, { t: 'rematch' });
  expect(r.phase).toBe('lobby');
  r.dispose();
});

test('host commands acknowledge success, stale rounds and unauthorized requests', async () => {
  const r = new Room('ABCDE', maps, { countdown: 5 }),
    h = enter(r, 'Host', true),
    g = enter(r, 'Guest');
  r.handle(h.ws, { t: 'start' });
  await delay(12);
  const action = {
    t: 'host-action',
    action: 'time',
    seconds: 30,
    matchId: r.matchId,
    holeIndex: 0,
    requestId: 'test',
  };
  r.handle(h.ws, action);
  expect(h.ws.frames.at(-1)).toMatchObject({ t: 'host-ack', requestId: 'test', ok: true });
  r.handle(g.ws, action);
  expect(g.ws.frames.at(-1)).toMatchObject({ t: 'host-ack', ok: false });
  r.handle(h.ws, { ...action, holeIndex: 2 });
  expect(h.ws.frames.at(-1)).toMatchObject({ t: 'host-ack', ok: false });
  r.handle(h.ws, { t: 'ping' });
  expect(h.ws.frames.at(-1).t).toBe('pong');
  r.dispose();
});

test('solo elimination plays all successful holes and records scorecard', async () => {
  const r = new Room('ABCDE', maps, { countdown: 5, results: 5 }),
    h = enter(r, 'Solo', true);
  r.handle(h.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q'], elimination: true },
  });
  r.handle(h.ws, { t: 'start' });
  await delay(12);
  r.handle(h.ws, { f: 1, s: 2, p: 3 });
  await delay(20);
  expect(r.phase).toBe('playing');
  expect(r.holeIndex).toBe(1);
  expect(r.roundHistory[0].rows[0]).toMatchObject({ uid: h.j.uid, strokes: 2, status: 'holed' });
  r.handle(h.ws, { f: 1, s: 3, p: 2 });
  await delay(12);
  expect(r.phase).toBe('final');
  expect(r.roundHistory.length).toBe(2);
  expect(r.standings()[0].totalStrokes).toBe(5);
  r.handle(h.ws, { t: 'rematch' });
  expect(r.roundHistory).toEqual([]);
  r.dispose();
});
test('late previous-round packets are ignored and host skips appear in history', async () => {
  const r = new Room('ABCDE', maps, { countdown: 5 }),
    h = enter(r, 'Host', true);
  r.handle(h.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q'], elimination: false },
  });
  r.handle(h.ws, { t: 'start' });
  await delay(10);
  const old = { matchId: r.matchId, holeIndex: 0 };
  r.handle(h.ws, { t: 'host-action', action: 'skip', ...old });
  await delay(10);
  expect(r.roundHistory[0]).toMatchObject({ index: 0, status: 'skipped', rows: [] });
  r.handle(h.ws, { t: 'prog', st: 9, ...old });
  r.handle(h.ws, { t: 'forfeit', ...old });
  expect(h.p.strokes).toBe(0);
  expect(h.p.done).toBe(false);
  r.handle(h.ws, { t: 'prog', st: 2, matchId: r.matchId, holeIndex: 1 });
  expect(h.p.strokes).toBe(2);
  r.dispose();
});

test('manual playlists exceed nine holes, random count is independent, and custom seconds validate', () => {
  const r = new Room('ABCDE', maps),
    h = enter(r, 'Host', true);
  r.handle(h.ws, { t: 'config', config: { holes: 7, timerMs: 127000, excludeDaily: true } });
  expect(r.config.holes).toBe(7);
  expect(r.config.timerMs).toBe(127000);
  const ids = Array.from({ length: 153 }, (_, i) => (i % 2 ? 'q' : 'p'));
  r.handle(h.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ids, holes: ids.length },
  });
  expect(r.config.holes).toBe(153);
  expect(r.config.selectedHoleIds).toEqual(ids);
  expect(r.config.randomHoles).toBe(7);
  r.handle(h.ws, { t: 'config', config: { mapSource: 'random' } });
  expect(r.config.holes).toBe(7);
  expect(r.config.excludeDaily).toBe(true);
  r.handle(h.ws, { t: 'config', config: { holes: 10 } });
  expect(r.config.holes).toBe(7);
  r.handle(h.ws, { t: 'config', config: { timerMs: 301000 } });
  expect(r.config.timerMs).toBe(127000);
  r.dispose();
});
test('lazy manual map preparation reaches later rounds and can be interrupted safely', async () => {
  let resolveLoad;
  const loads = [];
  const r = new Room('ABCDE', maps, {
    countdown: 5,
    results: 5,
    prepareMatch: async (c) => ({ ids: c.selectedHoleIds, specs: [maps.get('p').spec] }),
    loadMap: (id) => {
      loads.push(id);
      return new Promise((resolve) => (resolveLoad = resolve));
    },
  });
  const h = enter(r, 'Host', true);
  r.handle(h.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q', 'p'], elimination: false },
  });
  r.handle(h.ws, { t: 'start' });
  await delay(15);
  expect(r.phase).toBe('playing');
  r.handle(h.ws, { t: 'host-action', action: 'skip', matchId: r.matchId, holeIndex: 0 });
  await delay(1);
  expect(r.snapshot().preparing).toBe(true);
  expect(r.holeIndex).toBe(0);
  expect(loads).toEqual(['q']);
  resolveLoad(maps.get('q'));
  await delay(12);
  expect(r.holeIndex).toBe(1);
  expect(r.phase).toBe('playing');
  expect(r.snapshot().preparing).toBe(false);
  r.handle(h.ws, { t: 'host-action', action: 'skip', matchId: r.matchId, holeIndex: 1 });
  await delay(1);
  r.handle(h.ws, { t: 'host-action', action: 'end', matchId: r.matchId, holeIndex: 1 });
  resolveLoad(maps.get('p'));
  await delay(12);
  expect(r.phase).toBe('final');
  expect(r.holeIndex).toBe(1);
  r.dispose();
});
