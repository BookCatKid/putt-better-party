import assert from 'node:assert/strict';
const base = process.env.BASE || 'http://127.0.0.1:8789',
  headers = { origin: base, 'content-type': 'application/json' };
const post = async (path, data) => {
  const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(data) }),
    body = await res.json();
  assert(res.ok, JSON.stringify(body));
  return body;
};
const room = await post('/api/create', {}),
  page = await fetch(base + '/api/catalog?sort=new&offset=0').then((r) => r.json()),
  id = page.holes[0].id;
const sockets = [];
async function connect(name, host) {
  const j = await post('/api/join', { code: room.code, name }),
    frames = [];
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws/party/' + room.code, {
    headers: { origin: base },
  });
  sockets.push(ws);
  ws.onmessage = (e) => frames.push(JSON.parse(e.data));
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  const send = (m) => ws.send(JSON.stringify(m));
  const wait = async (predicate, timeout = 25000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const m = frames.find(predicate);
      if (m) return m;
      await Bun.sleep(25);
    }
    throw Error(JSON.stringify(frames.slice(-5).map(({ t, phase, code }) => ({ t, phase, code }))));
  };
  send({ t: 'join', ...j, host: host ? room.hostToken : undefined, protocol: 2, instance: name });
  await wait((m) => m.t === 'hello' && m.isHost === host);
  return { j, frames, send, wait };
}
try {
  const h = await connect('Lifecycle host', true),
    g = await connect('Lifecycle guest', false);
  await post('/api/import', {
    code: room.code,
    uid: h.j.uid,
    session: h.j.session,
    host: room.hostToken,
    id,
  });
  h.send({
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: [id, id], elimination: false, timerMs: 20000 },
  });
  await h.wait((m) => m.t === 'party' && m.config.selectedHoleIds.length === 2);
  h.send({ t: 'start' });
  await h.wait((m) => m.t === 'party' && m.preparing);
  for (let i = 0; i < 2; i++) {
    const pred = (m) => m.t === 'party' && m.phase === 'playing' && m.holeIndex === i;
    const s = await h.wait(pred);
    await g.wait(pred);
    assert.equal(s.currentMap.name, page.holes[0].title);
    assert.deepEqual(s.holeIds, [id, id]);
    h.send({ t: 'prog', st: 1 });
    h.send({ f: 1, s: 1, p: s.currentMap.par });
    g.send({ t: 'forfeit' });
    await h.wait((m) => m.t === 'party' && m.phase === 'hole-results' && m.holeIndex === i);
    console.log('PASS live WebSocket hole', i + 1);
  }
  const final = await h.wait((m) => m.t === 'final');
  await g.wait((m) => m.t === 'final');
  assert.equal(final.standings[0].uid, h.j.uid);
  assert.equal(final.standings[0].totalStrokes, 2);
  assert.equal(final.standings.length, 2);
  console.log('PASS final standings');
  h.frames.length = 0;
  g.frames.length = 0;
  h.send({ t: 'rematch' });
  await h.wait(
    (m) => m.t === 'party' && m.phase === 'lobby' && m.config.selectedHoleIds.length === 2,
  );
  await g.wait((m) => m.t === 'party' && m.phase === 'lobby');
  console.log('PASS rematch retains selected playlist');
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  for (const ws of sockets) ws.close();
}
