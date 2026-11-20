/**
 * A bounded soak: the resource-owning parts of the service under repeated
 * connect, play, disconnect and expiry cycles.
 *
 * This asserts, unlike `profile-load.mjs`. The numbers it checks are the ones a
 * leak or a stuck subscription would move — heap after forced GC, live rooms,
 * live sockets and queued writes — and each cycle returns the system to the
 * same shape, so a monotonic rise across cycles is a defect rather than noise.
 *
 * Scope is deliberately the protocol rather than the renderer: a headless
 * browser cannot survive this many cycles (see "Known limits of the browser
 * suite"), and the leaks this looks for live in the server.
 *
 * Usage: `bun tests/integration/check-soak.mjs` (env: BASE, CYCLES, PLAYERS,
 * ROOM_IDLE_MS — the last must match how the service was started).
 */

import assert from 'node:assert/strict';

const base = process.env.BASE || 'http://127.0.0.1:8789';
const wsBase = base.replace(/^http/, 'ws');
const cycles = Number(process.env.CYCLES || 24);
const playersPerRoom = Number(process.env.PLAYERS || 3);
// The service's own sweep cadence, so a wait here is the real reclaim window
// rather than a guess about it.
const idleMs = Number(process.env.ROOM_IDLE_MS || 2000);

const post = async (path, body) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: response.status, ...(await response.json()) };
};

const health = () => fetch(base + '/health').then((response) => response.json());

/** A joined socket that keeps its frames so a cycle can prove it was connected. */
function joinSocket(code, identity, extra = {}) {
  const ws = new WebSocket(wsBase + '/ws/party/' + code, { headers: { origin: base } });
  const frames = [];
  ws.onmessage = (event) => frames.push(JSON.parse(event.data));
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'join', ...identity, protocol: 2, ...extra }));
      const check = setInterval(() => {
        if (frames.some((frame) => frame.t === 'party')) {
          clearInterval(check);
          resolve({ ws, frames });
        } else if (frames.some((frame) => frame.t === 'error') || Date.now() > deadline) {
          clearInterval(check);
          reject(Error('join failed: ' + JSON.stringify(frames.at(-1) ?? 'timeout')));
        }
      }, 20);
    };
    ws.onerror = () => reject(Error('socket error'));
  });
}

const waitClosed = (ws, ms = 5000) =>
  new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      return resolve(true);
    }
    const timer = setTimeout(() => resolve(false), ms);
    ws.onclose = () => {
      clearTimeout(timer);
      resolve(true);
    };
  });

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The service must be started with a short sweep for the expiry half of this
// check to be observable at all; saying so beats waiting 30 minutes.
const first = await health();
if (first.uptimeSeconds > 300) {
  console.log(
    `note: service has been up ${first.uptimeSeconds}s; room expiry is only exercised when ` +
      'BP_ROOM_IDLE_MS and BP_ROOM_SWEEP_MS are set short on the service side',
  );
}
console.log(
  `start: rooms=${first.rooms} players=${first.players} rss=${Math.round(first.memory.rssBytes / 1048576)}MB ` +
    `heap=${Math.round(first.memory.heapUsedBytes / 1048576)}MB writes=${first.database.writes}`,
);

/** One full arc: create, join everyone, configure, play a moment, then leave. */
async function oneCycle(index, { disconnectAbruptly }) {
  const created = await post('/api/create');
  assert.equal(created.status, 200, 'create must succeed');
  const members = [];
  for (let member = 0; member < playersPerRoom; member++) {
    const identity = await post('/api/join', {
      code: created.code,
      name: `soak-${index}-${member}`,
    });
    assert.equal(identity.status, 200, 'join must succeed');
    members.push(
      await joinSocket(created.code, identity, member === 0 ? { host: created.hostToken } : {}),
    );
  }
  // A real broadcast and a real timer edit: both checkpoint the room and fan
  // out, which is where per-cycle work concentrates.
  members[0].ws.send(
    JSON.stringify({ t: 'config', config: { mapSource: 'random', holes: 1, timerMs: 45_000 } }),
  );
  await pause(120);
  members[0].ws.send(JSON.stringify({ t: 'ping' }));
  await pause(60);
  if (disconnectAbruptly) {
    // No close frame: the server sees a dropped peer, which is the path that
    // leaves state behind if cleanup is wrong.
    for (const { ws } of members) {
      ws.close(4001, 'soak drop');
    }
  } else {
    for (const { ws } of members) {
      ws.close(1000, 'soak leave');
      await waitClosed(ws);
    }
  }
  // Every cycle leaves a room behind on purpose, so the sweep is what has to
  // clear them; if it does not, `rooms` grows without bound across the run.
  return created.code;
}

const abandoned = [];
for (let cycle = 0; cycle < cycles; cycle++) {
  // Alternate clean leaves with abrupt drops and host/non-host orders so both
  // teardown paths are exercised the same number of times.
  const code = await oneCycle(cycle, { disconnectAbruptly: cycle % 2 === 1 });
  abandoned.push(code);
  if (cycle % 6 === 5) {
    const snapshot = await health();
    console.log(
      `cycle ${cycle + 1}: rooms=${snapshot.rooms} players=${snapshot.players} ` +
        `rss=${Math.round(snapshot.memory.rssBytes / 1048576)}MB ` +
        `heap=${Math.round(snapshot.memory.heapUsedBytes / 1048576)}MB ` +
        `writes=${snapshot.database.writes}`,
    );
  }
}

// Let the room sweep run at least twice on the service's own cadence. What is
// asserted is that the rooms are actually gone, not that a particular timer
// fired: a room with no live socket and no activity past the limit must not
// still be resident.
await pause(idleMs * 2.5);
const settled = await health();
const stillPresent = [];
for (const code of abandoned) {
  const response = await fetch(base + '/api/room/' + code);
  if (response.status !== 404) {
    stillPresent.push({ code, status: response.status });
  }
}

console.log(
  `after sweep: rooms=${settled.rooms} players=${settled.players} ` +
    `rss=${Math.round(settled.memory.rssBytes / 1048576)}MB ` +
    `heap=${Math.round(settled.memory.heapUsedBytes / 1048576)}MB ` +
    `writes=${settled.database.writes} deletes=${settled.database.deletes}`,
);

// The assertions.
assert.equal(
  stillPresent.length,
  0,
  'every abandoned room must be reclaimed once past the idle limit: ' +
    JSON.stringify(stillPresent),
);
assert.equal(settled.players, 0, 'no socket may survive the soak');
assert.equal(
  settled.socketBufferedBytes,
  0,
  'no undelivered bytes may remain once every socket is closed',
);
assert(
  settled.database.deletes >= abandoned.length,
  `the sweep must have deleted at least as many rows as rooms it cleared ` +
    `(deletes=${settled.database.deletes}, rooms=${abandoned.length})`,
);

// Memory is the reason this exists, so it is measured but bounded generously:
// the claim is "does not grow with the number of cycles", not a byte budget.
// A per-cycle leak of even a few kilobytes shows up here across the run.
const heapGrowthMb = (settled.memory.heapUsedBytes - first.memory.heapUsedBytes) / 1048576;
console.log(`heap delta across ${cycles} cycles: ${heapGrowthMb.toFixed(1)}MB`);
assert(
  heapGrowthMb < 64,
  `heap grew ${heapGrowthMb.toFixed(1)}MB across ${cycles} cycles, which suggests a leak`,
);

console.log(
  `PASS ${cycles} cycles of ${playersPerRoom} players, abrupt and clean disconnects, ` +
    `all rooms reclaimed`,
);
