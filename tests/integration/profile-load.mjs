/**
 * Load profile for the three axes the backlog asks about before any
 * optimisation: many concurrent rooms, large playlists and long-running
 * connections.
 *
 * This is a probe, not a gate — it prints measured numbers rather than
 * asserting thresholds, so a regression review compares runs rather than a
 * baked-in constant. Everything runs over the public protocol against a live
 * server (default the local dev instance), so what it measures is what a
 * player costs: `/api/create`, `/api/join`, the WebSocket join frame, host
 * `config` broadcasts, `ping`, and `/health` for the server's own view of
 * memory and connection counts.
 *
 * Usage: `bun tests/integration/profile-load.mjs` (env: BASE, ROOMS, MEMBERS,
 * PLAYLIST_SIZES, HOLD_MS).
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const wsBase = base.replace(/^http/, 'ws');
const roomsTarget = Number(process.env.ROOMS || 120);
const membersPerRoom = Number(process.env.MEMBERS || 2);
// Broadcast sizes are bounded by how many real courses were seeded into the
// server's validated index: a playlist may only name validated public ids.
const playlistSizes = (process.env.PLAYLIST_SIZES || '24,96')
  .split(',')
  .map((size) => Number(size));
const holdMs = Number(process.env.HOLD_MS || 20000);

const post = async (path, body) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  // 429 is the room cap answering, not a failure: the caller decides whether
  // fewer rooms still make a useful measurement.
  if (!response.ok && response.status !== 429) {
    throw Error(path + ' -> ' + response.status);
  }
  return { status: response.status, ...(await response.json()) };
};

const health = () => fetch(base + '/health').then((response) => response.json());

const percentile = (values, ratio) => {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
};

const stats = (values) => ({
  n: values.length,
  avg: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10,
  p95: percentile(values, 0.95),
  max: Math.max(...values),
});

const mb = (bytes) => Math.round((bytes / 1_048_576) * 10) / 10;

/** Join one socket to a room and resolve once the hello/party frames arrive. */
function joinSocket(code, identity, extra = {}) {
  const ws = new WebSocket(wsBase + '/ws/party/' + code, { headers: { origin: base } });
  const frames = [];
  ws.onmessage = (event) => frames.push(JSON.parse(event.data));
  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'join', ...identity, protocol: 2, ...extra }));
      const deadline = Date.now() + 15000;
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

/** Wait for a frame matching `predicate`, resolving with ms since `sentAt`. */
function waitFrame(frameList, predicate, sentAt, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const check = setInterval(() => {
      if (frameList.some(predicate)) {
        clearInterval(check);
        resolve(Date.now() - sentAt);
      } else if (Date.now() > deadline) {
        clearInterval(check);
        reject(Error('frame wait timed out'));
      }
    }, 10);
  });
}

// ---------------------------------------------------------------------------
// Phase A: many concurrent rooms.
// ---------------------------------------------------------------------------
const before = await health();
console.log(
  `baseline: rooms=${before.rooms} players=${before.players} rss=${mb(before.memory.rssBytes)}MB`,
);

const createLatencies = [];
const joinLatencies = [];
const parties = [];
let cappedAt = null;
for (let room = 0; room < roomsTarget; room++) {
  let started = Date.now();
  const created = await post('/api/create');
  createLatencies.push(Date.now() - started);
  if (created.status === 429) {
    // The 100-room process cap is part of the profile: "many concurrent rooms"
    // means at most one hundred, including any left over from earlier sessions.
    cappedAt = parties.length;
    break;
  }
  const { code, hostToken } = created;
  const members = [];
  const uids = [];
  const sessions = [];
  for (let member = 0; member < membersPerRoom; member++) {
    const identity = await post('/api/join', { code, name: 'probe-' + member });
    uids.push(identity.uid);
    sessions.push(identity.session);
    started = Date.now();
    members.push(await joinSocket(code, identity, member === 0 ? { host: hostToken } : {}));
    joinLatencies.push(Date.now() - started);
  }
  parties.push({ code, hostToken, members, uids, sessions });
}
const populated = await health();
if (cappedAt !== null) {
  console.log(`  room cap reached after ${cappedAt} new rooms (server total ${populated.rooms})`);
}
if (parties.length === 0) {
  console.log('no rooms could be created; nothing to profile');
  process.exit(0);
}
console.log(
  `rooms=${parties.length} x${membersPerRoom}: create ${JSON.stringify(stats(createLatencies))}ms`,
);
console.log(`  join ${JSON.stringify(stats(joinLatencies))}ms`);
console.log(
  `  health: rooms=${populated.rooms} players=${populated.players} ` +
    `rss=${mb(populated.memory.rssBytes)}MB (+${mb(populated.memory.rssBytes - before.memory.rssBytes)}MB)`,
);

// ---------------------------------------------------------------------------
// Seed the validated course index.
//
// `configure` only accepts ids the server has already validated upstream, so
// a realistic large playlist first costs one `/api/import` per course — that
// paced validation pass is itself the number this phase measures.
// ---------------------------------------------------------------------------
const needed = Math.max(...playlistSizes);
const seedIds = [];
for (let offset = 0; seedIds.length < needed; offset += 24) {
  const catalogPage = await fetch(base + '/api/catalog?sort=new&offset=' + offset).then(
    (response) => response.json(),
  );
  if (!catalogPage.holes?.length) {
    break;
  }
  seedIds.push(...catalogPage.holes.map((hole) => hole.id));
}
seedIds.length = Math.min(needed, seedIds.length);
const seedRoom = parties[0];
const importLatencies = [];
for (const id of seedIds) {
  const started = Date.now();
  await post('/api/import', {
    code: seedRoom.code,
    uid: seedRoom.uids[0],
    session: seedRoom.sessions[0],
    host: seedRoom.hostToken,
    id,
    saved: true,
  });
  importLatencies.push(Date.now() - started);
}
console.log(
  `seeded ${seedIds.length} validated ids: /api/import ${JSON.stringify(stats(importLatencies))}ms`,
);

// ---------------------------------------------------------------------------
// Phase B: large playlist broadcasts.
// Each host config update rewrites the room's playlist and fans the party
// frame out to every member; the number measured is send -> party-frame-seen.
// ---------------------------------------------------------------------------
if (seedIds.length < Math.max(...playlistSizes)) {
  console.log('warning: only ' + seedIds.length + ' validated ids; large sizes are capped at that');
}
const broadcast = {};
for (const requested of playlistSizes) {
  const size = Math.min(requested, seedIds.length);
  const latencies = [];
  const ids = seedIds.slice(0, size);
  for (const { members } of parties) {
    const host = members[0];
    const sentAt = Date.now();
    host.ws.send(
      JSON.stringify({
        t: 'config',
        config: { mapSource: 'picked', selectedHoleIds: ids, holes: Math.max(1, size) },
      }),
    );
    // The accepted configuration echoes back in the party snapshot to every
    // member; measuring the last member sees validate+broadcast+serialize.
    latencies.push(
      await waitFrame(
        members.at(-1).frames,
        (frame) => frame.t === 'party' && frame.config?.selectedHoleIds?.length === size,
        sentAt,
      ),
    );
  }
  broadcast[size] = stats(latencies);
}
for (const [size, sizeStats] of Object.entries(broadcast)) {
  console.log(`playlist ${size} ids -> party frame: ${JSON.stringify(sizeStats)}ms`);
}

// ---------------------------------------------------------------------------
// Phase C: long-running connections.
// ---------------------------------------------------------------------------
const rssSeries = [populated.memory.rssBytes];
const pongLatencies = [];
const holdStarted = Date.now();
const pingInterval = setInterval(() => {
  for (const { members } of parties) {
    for (const { ws } of members) {
      ws.send(JSON.stringify({ t: 'ping' }));
    }
  }
}, 2000);
while (Date.now() - holdStarted < holdMs) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const snap = await health();
  rssSeries.push(snap.memory.rssBytes);
  const probe = parties[0];
  const sentAt = Date.now();
  probe.members[0].ws.send(JSON.stringify({ t: 'ping' }));
  pongLatencies.push(
    await waitFrame(probe.members[0].frames, (frame) => frame.t === 'pong', sentAt),
  );
}
clearInterval(pingInterval);
const after = await health();
console.log(
  `held ${parties.length * membersPerRoom} sockets ${holdMs / 1000}s: ` +
    `pong ${JSON.stringify(stats(pongLatencies))}ms`,
);
console.log(
  `  rss ${mb(rssSeries[0])}MB -> ${mb(after.memory.rssBytes)}MB ` +
    `(+${mb(after.memory.rssBytes - populated.memory.rssBytes)}MB over hold; series ` +
    rssSeries.map(mb).join(', ') +
    ')',
);

// ---------------------------------------------------------------------------
for (const { members } of parties) {
  for (const { ws } of members) {
    ws.close();
  }
}
console.log(
  `summary: ${roomsTarget} rooms, ${parties.length * membersPerRoom} sockets, ` +
    `create+join+broadcast+hold profiled against ${base}`,
);
