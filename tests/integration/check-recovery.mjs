import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = await mkdtemp(path.join(tmpdir(), 'better-party-recovery-'));
const port = 8791;
const base = 'http://127.0.0.1:' + port;
const headers = { origin: base, 'content-type': 'application/json' };
let server;
let sockets = [];
const wait = async (fn, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await fn();
    if (value) {
      return value;
    }
    await Bun.sleep(50);
  }
  throw Error('Timed out');
};
async function start() {
  server = Bun.spawn(['bun', 'src/server.ts'], {
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
  for (const ws of sockets) {
    ws.close();
  }
  sockets = [];
  if (server) {
    server.kill();
    await server.exited;
    server = null;
  }
}
const post = async (processHandle, data) => {
  const response = await fetch(base + processHandle, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
  const identity = await response.json();
  assert(response.ok, JSON.stringify(identity));
  return identity;
};
async function connect(room, identity) {
  const frames = [];
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws/party/' + room.code, {
    headers: { origin: base },
  });
  sockets.push(ws);
  ws.onmessage = (event) => frames.push(JSON.parse(event.data));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const send = (message) => ws.send(JSON.stringify(message));
  const find = (fn) => wait(() => frames.find(fn));
  send({ t: 'join', ...identity, host: room.hostToken, protocol: 2, instance: 'recovery-test' });
  await find((message) => message.t === 'hello' && message.isHost);
  return { ws, send, find };
}
try {
  await start();
  const room = await post('/api/create', {});
  const identity = await post('/api/join', { code: room.code, name: 'Recovery host' });
  const host = await connect(room, identity);
  const page = await fetch(base + '/api/catalog').then((response) => response.json());
  const id = page.holes[0].id;
  await post('/api/import', {
    code: room.code,
    uid: identity.uid,
    session: identity.session,
    host: room.hostToken,
    id,
  });
  host.send({ t: 'config', config: { mapSource: 'picked', selectedHoleIds: [id], locked: true } });
  await host.find(
    (message) =>
      message.t === 'party' && message.config.locked && message.config.selectedHoleIds.length === 1,
  );
  host.send({ t: 'start' });
  await host.find((message) => message.t === 'party' && message.phase === 'countdown');
  await stop();
  await start();
  const state = await fetch(base + '/api/room/' + room.code).then((response) => response.json());
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
  const restored = await connect(room, returned);
  const lobby = await restored.find((message) => message.t === 'party' && message.recoveryNotice);
  assert.deepEqual(lobby.config.selectedHoleIds, [id]);
  assert.equal(lobby.playlistTitles[id], page.holes[0].title);
  assert.equal(
    (await fetch(base + '/api/map/' + id)).status,
    404,
    'No disk-persisted playable map',
  );
  restored.send({ t: 'start' });
  const countdown = await restored.find(
    (message) => message.t === 'party' && message.phase === 'countdown',
  );
  assert.equal(countdown.currentMap.name, page.holes[0].title);
  console.log(
    'PASS fresh process recovery, host authentication, locked lobby, selected playlist, upstream refetch',
  );
} finally {
  await stop();
  await rm(dir, { recursive: true, force: true });
}
