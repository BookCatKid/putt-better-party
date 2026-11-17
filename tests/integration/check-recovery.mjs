import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = await mkdtemp(path.join(tmpdir(), 'better-party-recovery-'));
const port = 8791,
  base = 'http://127.0.0.1:' + port,
  headers = { origin: base, 'content-type': 'application/json' };
let server,
  sockets = [];
const wait = async (fn, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await Bun.sleep(50);
  }
  throw Error('Timed out');
};
async function start() {
  server = Bun.spawn(['bun', 'src/server.js'], {
    env: { ...process.env, PORT: String(port), BP_DB: path.join(dir, 'rooms.sqlite') },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  await wait(async () => {
    try {
      return (await fetch(base + '/health')).ok;
    } catch {
      return false;
    }
  }, 5000);
}
async function stop() {
  for (const ws of sockets) ws.close();
  sockets = [];
  if (server) {
    server.kill();
    await server.exited;
    server = null;
  }
}
const post = async (p, data) => {
  const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(data) }),
    j = await r.json();
  assert(r.ok, JSON.stringify(j));
  return j;
};
async function connect(room, identity) {
  const frames = [],
    ws = new WebSocket(base.replace('http', 'ws') + '/ws/party/' + room.code, {
      headers: { origin: base },
    });
  sockets.push(ws);
  ws.onmessage = (e) => frames.push(JSON.parse(e.data));
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  const send = (m) => ws.send(JSON.stringify(m)),
    find = (fn) => wait(() => frames.find(fn));
  send({ t: 'join', ...identity, host: room.hostToken, protocol: 2, instance: 'recovery-test' });
  await find((m) => m.t === 'hello' && m.isHost);
  return { ws, send, find };
}
try {
  await start();
  const room = await post('/api/create', {}),
    identity = await post('/api/join', { code: room.code, name: 'Recovery host' }),
    h = await connect(room, identity);
  const page = await fetch(base + '/api/catalog').then((r) => r.json()),
    id = page.holes[0].id;
  await post('/api/import', {
    code: room.code,
    uid: identity.uid,
    session: identity.session,
    host: room.hostToken,
    id,
  });
  h.send({ t: 'config', config: { mapSource: 'picked', selectedHoleIds: [id], locked: true } });
  await h.find((m) => m.t === 'party' && m.config.locked && m.config.selectedHoleIds.length === 1);
  h.send({ t: 'start' });
  await h.find((m) => m.t === 'party' && m.phase === 'countdown');
  await stop();
  await start();
  const state = await fetch(base + '/api/room/' + room.code).then((r) => r.json());
  assert.equal(state.phase, 'lobby');
  assert.equal(state.locked, true);
  const unauthorized = await fetch(base + '/api/join', {
    method: 'POST',
    headers,
    body: JSON.stringify({ code: room.code, name: 'New player' }),
  });
  assert(!unauthorized.ok);
  const returned = await post('/api/join', {
    code: room.code,
    name: 'Recovery host',
    uid: identity.uid,
    session: identity.session,
  });
  assert.equal(returned.uid, identity.uid);
  const restored = await connect(room, returned),
    lobby = await restored.find((m) => m.t === 'party' && m.recoveryNotice);
  assert.deepEqual(lobby.config.selectedHoleIds, [id]);
  assert.equal(lobby.playlistTitles[id], page.holes[0].title);
  assert.equal(
    (await fetch(base + '/api/map/' + id)).status,
    404,
    'No disk-persisted playable map',
  );
  restored.send({ t: 'start' });
  const countdown = await restored.find((m) => m.t === 'party' && m.phase === 'countdown');
  assert.equal(countdown.currentMap.name, page.holes[0].title);
  console.log(
    'PASS fresh process recovery, host authentication, locked lobby, selected playlist, upstream refetch',
  );
} finally {
  await stop();
  await rm(dir, { recursive: true, force: true });
}
