import assert from 'node:assert/strict';
const base = process.env.BASE || 'http://127.0.0.1:8789';
const headers = { origin: base, 'content-type': 'application/json' };
const post = async (path, data) => {
  const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(data) });
  const body = await res.json();
  assert(res.ok, JSON.stringify(body));
  return body;
};
const room = await post('/api/create', {});
const page = await fetch(base + '/api/catalog?sort=new&offset=0').then((response) =>
  response.json(),
);
const id = page.holes[0].id;
const sockets = [];
async function connect(name, host) {
  const identity = await post('/api/join', { code: room.code, name });
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
  const wait = async (predicate, timeout = 25000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const message = frames.find(predicate);
      if (message) {
        return message;
      }
      await Bun.sleep(25);
    }
    throw Error(
      JSON.stringify(
        frames.slice(-5).map(({ t: target, phase, code }) => ({ t: target, phase, code })),
      ),
    );
  };
  send({
    t: 'join',
    ...identity,
    host: host ? room.hostToken : undefined,
    protocol: 2,
    instance: name,
  });
  await wait((message) => message.t === 'hello' && message.isHost === host);
  return { j: identity, frames, send, wait };
}
try {
  const host = await connect('Lifecycle host', true);
  const guest = await connect('Lifecycle guest', false);
  await post('/api/import', {
    code: room.code,
    uid: host.j.uid,
    session: host.j.session,
    host: room.hostToken,
    id,
  });
  host.send({
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: [id, id], elimination: false, timerMs: 20000 },
  });
  await host.wait(
    (message) => message.t === 'party' && message.config.selectedHoleIds.length === 2,
  );
  host.send({ t: 'start' });
  await host.wait((message) => message.t === 'party' && message.preparing);
  for (let index = 0; index < 2; index++) {
    const pred = (message) =>
      message.t === 'party' && message.phase === 'playing' && message.holeIndex === index;
    const snapshot = await host.wait(pred);
    await guest.wait(pred);
    assert.equal(snapshot.currentMap.name, page.holes[0].title);
    assert.deepEqual(snapshot.holeIds, [id, id]);
    host.send({ t: 'prog', st: 1 });
    host.send({ f: 1, s: 1, p: snapshot.currentMap.par });
    guest.send({ t: 'forfeit' });
    await host.wait(
      (message) =>
        message.t === 'party' && message.phase === 'hole-results' && message.holeIndex === index,
    );
    console.log('PASS live WebSocket hole', index + 1);
  }
  const final = await host.wait((message) => message.t === 'final');
  await guest.wait((message) => message.t === 'final');
  assert.equal(final.standings[0].uid, host.j.uid);
  assert.equal(final.standings[0].totalStrokes, 2);
  assert.equal(final.standings.length, 2);
  console.log('PASS final standings');
  host.frames.length = 0;
  guest.frames.length = 0;
  host.send({ t: 'rematch' });
  await host.wait(
    (message) =>
      message.t === 'party' &&
      message.phase === 'lobby' &&
      message.config.selectedHoleIds.length === 2,
  );
  await guest.wait((message) => message.t === 'party' && message.phase === 'lobby');
  console.log('PASS rematch retains selected playlist');
} catch (event) {
  console.error(event);
  process.exitCode = 1;
} finally {
  for (const ws of sockets) {
    ws.close();
  }
}
