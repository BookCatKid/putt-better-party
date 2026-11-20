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

/**
 * The newest listing is community-authored, so it can legitimately be a course
 * the pinned validator refuses (a decoration scale outside the accepted range,
 * for example) — that is the server working, not a regression. The catalogue
 * assertion above is about listing; everything below needs a course that
 * actually imports, so it takes the first one that does. Nothing here may pass
 * without one, so an empty result is still a failure.
 */
async function firstImportableCourse(room, identity, host) {
  for (const candidate of [...page.holes, ...page2.holes]) {
    const response = await fetch(base + '/api/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: room.code,
        uid: identity.uid,
        session: identity.session,
        host,
        id: candidate.id,
      }),
    });
    if (response.status === 200) {
      return { course: candidate, response };
    }
  }
  throw Error('no course on the first two pages could be imported');
}
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
  const { course } = await firstImportableCourse(
    manualParty.r,
    manualParty.j,
    manualParty.r.hostToken,
  );
  // A guest in the same lobby is a real, connected member with its own session.
  // Authorization to import is the crown's, not membership's: the guest must be
  // refused even though every other part of the request is valid. The guest has
  // to hold a live socket here, otherwise the "connected player" guard would
  // reject it for the wrong reason and the host rule would go untested.
  const guestIdentity = await post('/api/join', {
    code: manualParty.r.code,
    name: 'Catalog guest',
  });
  const guestSocket = new WebSocket(
    base.replace('http', 'ws') + '/ws/party/' + manualParty.r.code,
    { headers: { origin: base } },
  );
  await new Promise((resolve, reject) => {
    guestSocket.onopen = resolve;
    guestSocket.onerror = reject;
  });
  guestSocket.send(
    JSON.stringify({ t: 'join', ...guestIdentity, protocol: 2, instance: 'catalog-guest' }),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  const guestAttempt = (overrides) =>
    fetch(base + '/api/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: manualParty.r.code,
        uid: guestIdentity.uid,
        session: guestIdentity.session,
        host: manualParty.r.hostToken,
        id: course.id,
        ...overrides,
      }),
    });
  try {
    assert.equal(
      (await guestAttempt({})).status,
      403,
      'a connected guest may not import, even while holding the host capability',
    );
    assert.equal(
      (
        await guestAttempt({
          uid: manualParty.j.uid,
          session: guestIdentity.session,
        })
      ).status,
      403,
      "a guest's session may not stand in for the host's",
    );
  } finally {
    guestSocket.close();
  }
  // The host mirroring the same request succeeds, so the refusal above is about
  // who is asking rather than the request being malformed.
  assert.equal(
    (
      await fetch(base + '/api/import', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          code: manualParty.r.code,
          uid: manualParty.j.uid,
          session: manualParty.j.session,
          host: manualParty.r.hostToken,
          id: course.id,
        }),
      })
    ).status,
    200,
    'the host request must still be admitted',
  );
  console.log('PASS only the host may import, even with a valid identity and capability');
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
// Catalog ids and specification ids are different namespaces. The room needs
// both: the catalog id keys the playlist, while the renderer and the readiness
// report see the id inside the specification.
const identityParty = await connectRoom();
try {
  const { course } = await firstImportableCourse(
    identityParty.r,
    identityParty.j,
    identityParty.r.hostToken,
  );
  const imported = await post('/api/import', {
    code: identityParty.r.code,
    uid: identityParty.j.uid,
    session: identityParty.j.session,
    host: identityParty.r.hostToken,
    id: course.id,
  });
  assert.equal(imported.id, course.id);
  assert.equal(imported.title, course.title);
  const map = await get('/api/map/' + encodeURIComponent(course.id));
  assert.equal(map.id, course.id);
  assert.equal(map.title, course.title);
  assert.equal(typeof map.spec.id, 'string');
  // A specification id is not a catalog id, so it names no course on its own.
  if (map.spec.id !== course.id) {
    const bySpec = await fetch(base + '/api/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: identityParty.r.code,
        uid: identityParty.j.uid,
        session: identityParty.j.session,
        host: identityParty.r.hostToken,
        id: map.spec.id,
        saved: true,
      }),
    });
    assert.equal(bySpec.status, 400);
  }
  console.log(
    'PASS catalog identity',
    course.id,
    '->',
    map.spec.id,
    course.id === map.spec.id ? '(same)' : '(specification id differs)',
  );
} finally {
  identityParty.ws.close();
}

// Only a course the live public detail vouches for may become playable. The
// bundled research maps under maps/ are deliberately not reachable this way, and
// a made-up id must not be served from disk or from a stale cache.
const sourceParty = await connectRoom();
try {
  const listed = page.holes[0];
  const importCourse = (id, saved) =>
    fetch(base + '/api/import', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        code: sourceParty.r.code,
        uid: sourceParty.j.uid,
        session: sourceParty.j.session,
        host: sourceParty.r.hostToken,
        id,
        saved,
      }),
    });
  assert.equal((await importCourse(listed.id, true)).status, 200);
  for (const id of [
    'scenic',
    'starfall',
    'public-52e0ccaa8f0347ad84ef9ac42fa12682',
    'deadbeefdeadbeefdeadbeefdeadbeef',
  ]) {
    const response = await importCourse(id, true);
    assert.equal(response.status, 400, id + ' must not be importable');
    assert.equal((await fetch(base + '/api/map/' + id)).status, 404, id + ' must not be served');
  }
  console.log('PASS only an upstream-validated public course is playable');
} finally {
  sourceParty.ws.close();
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
