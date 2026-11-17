import assert from 'node:assert/strict';
const base = process.env.BASE || 'http://127.0.0.1:8789',
  headers = { origin: base, 'content-type': 'application/json' };
const get = async (path) => {
  const r = await fetch(base + path);
  assert(r.ok, await r.statusText);
  return r.json();
};
const post = async (path, data) => {
  const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(data) });
  const d = await r.json();
  assert(r.ok, JSON.stringify(d));
  return d;
};
const page = await get('/api/catalog?sort=new&offset=0');
assert(page.total > 24);
assert(page.holes.length === 24);
const page2 = await get('/api/catalog?sort=new&offset=24');
assert.equal(page2.offset, 24);
assert.notEqual(page.holes[0].id, page2.holes[0].id);
async function connectRoom() {
  const r = await post('/api/create', {}),
    j = await post('/api/join', { code: r.code, name: 'Catalog test', host: r.hostToken });
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws/party/' + r.code, {
    headers: { origin: base },
  });
  const frames = [];
  ws.onmessage = (e) => frames.push(JSON.parse(e.data));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.send(JSON.stringify({ t: 'join', ...j, host: r.hostToken, protocol: 2 }));
  async function wait(f) {
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      const m = frames.find(f);
      if (m) return m;
      await Bun.sleep(50);
    }
    throw Error(JSON.stringify(frames.map((x) => ({ t: x.t, phase: x.phase, msg: x.msg }))));
  }
  await wait((m) => m.t === 'hello' && m.isHost);
  const send = (m) => ws.send(JSON.stringify(m));
  return { r, j, ws, wait, send };
}
const a = await connectRoom();
try {
  const h = page.holes[0];
  await post('/api/import', {
    code: a.r.code,
    uid: a.j.uid,
    session: a.j.session,
    host: a.r.hostToken,
    id: h.id,
  });
  a.send({ t: 'config', config: { mapSource: 'picked', selectedHoleIds: [h.id] } });
  await a.wait((m) => m.t === 'party' && m.config.selectedHoleIds[0] === h.id);
  a.send({ t: 'start' });
  const s = await a.wait((m) => m.t === 'party' && m.phase === 'countdown');
  assert.equal(s.currentMap.name, h.title);
  assert.deepEqual(s.holeIds, [h.id]);
  console.log('PASS manual selection from live catalog:', s.currentMap.name);
} finally {
  a.ws.close();
}
const b = await connectRoom();
try {
  b.send({ t: 'config', config: { mapSource: 'random', holes: 2 } });
  await b.wait((m) => m.t === 'party' && m.config.holes === 2);
  b.send({ t: 'start' });
  const s = await b.wait((m) => m.t === 'party' && m.phase === 'countdown');
  assert.equal(s.holeIds.length, 2);
  assert.equal(new Set(s.holeIds).size, 2);
  assert(s.currentMap.pieces.length);
  console.log('PASS random public selection:', s.holeIds, s.currentMap.name);
} finally {
  b.ws.close();
}
