import assert from 'node:assert/strict';
const base = process.env.BASE || 'http://127.0.0.1:8789';
const headers = { origin: base, 'content-type': 'application/json' };
const get = async (path) => {
  const response = await fetch(base + path);
  assert(response.ok, await response.statusText);
  return response.json();
};
const post = async (path, data) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  });
  const dataValue = await response.json();
  assert(response.ok, JSON.stringify(dataValue));
  return dataValue;
};
const page = await get('/api/catalog?sort=new&offset=0');
assert(page.total > 24);
assert(page.holes.length === 24);
const page2 = await get('/api/catalog?sort=new&offset=24');
assert.equal(page2.offset, 24);
assert.notEqual(page.holes[0].id, page2.holes[0].id);
async function connectRoom() {
  const room = await post('/api/create', {});
  const identity = await post('/api/join', {
    code: room.code,
    name: 'Catalog test',
    host: room.hostToken,
  });
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws/party/' + room.code, {
    headers: { origin: base },
  });
  const frames = [];
  ws.onmessage = (event) => frames.push(JSON.parse(event.data));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  ws.send(JSON.stringify({ t: 'join', ...identity, host: room.hostToken, protocol: 2 }));
  async function wait(predicate) {
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      const message = frames.find(predicate);
      if (message) {
        return message;
      }
      await Bun.sleep(50);
    }
    throw Error(
      JSON.stringify(frames.map((frame) => ({ t: frame.t, phase: frame.phase, msg: frame.msg }))),
    );
  }
  await wait((message) => message.t === 'hello' && message.isHost);
  const send = (message) => ws.send(JSON.stringify(message));
  return { r: room, j: identity, ws, wait, send };
}
const manualParty = await connectRoom();
try {
  const course = page.holes[0];
  await post('/api/import', {
    code: manualParty.r.code,
    uid: manualParty.j.uid,
    session: manualParty.j.session,
    host: manualParty.r.hostToken,
    id: course.id,
  });
  manualParty.send({ t: 'config', config: { mapSource: 'picked', selectedHoleIds: [course.id] } });
  await manualParty.wait(
    (message) => message.t === 'party' && message.config.selectedHoleIds[0] === course.id,
  );
  manualParty.send({ t: 'start' });
  const snapshot = await manualParty.wait(
    (message) => message.t === 'party' && message.phase === 'countdown',
  );
  assert.equal(snapshot.currentMap.name, course.title);
  assert.deepEqual(snapshot.holeIds, [course.id]);
  console.log('PASS manual selection from live catalog:', snapshot.currentMap.name);
} finally {
  manualParty.ws.close();
}
const randomParty = await connectRoom();
try {
  randomParty.send({ t: 'config', config: { mapSource: 'random', holes: 2 } });
  await randomParty.wait((message) => message.t === 'party' && message.config.holes === 2);
  randomParty.send({ t: 'start' });
  const snapshot = await randomParty.wait(
    (message) => message.t === 'party' && message.phase === 'countdown',
  );
  assert.equal(snapshot.holeIds.length, 2);
  assert.equal(new Set(snapshot.holeIds).size, 2);
  assert(snapshot.currentMap.pieces.length);
  console.log('PASS random public selection:', snapshot.holeIds, snapshot.currentMap.name);
} finally {
  randomParty.ws.close();
}
