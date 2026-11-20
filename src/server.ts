/**
 * Process bootstrap: configuration, the room store, collaborators and the
 * `Bun.serve` socket. The request map itself lives in `http-routes.ts`; the
 * WebSocket frame handlers live on `Room`. What remains here is wiring — the
 * pieces that exist because a process must construct and own them.
 */
import { ReplayArchive } from './replays.js';
import { Leaderboard } from './leaderboard.js';
import { PlaylistJobs } from './playlist-generator.js';
import { createAdmin } from './admin.js';
import { Room } from './room.js';
import { readServerConfig } from './config.js';
import { shutdownResources } from './shutdown.js';
import { logEvent } from './event-log.js';
import { withDeploymentHeaders } from './deployment-headers.js';
import { RoomStore } from './room-store.js';
import { courseIndex, courseCount, fetchPublicMap, prepareMatch } from './catalog.js';
import { errorMessage } from './domain.js';
import { rememberPublicMetadata } from './upstream.js';
import { MAX_JSON_BODY_BYTES } from './request-guards.js';
import { ROOM_IDLE_LIMIT_MS, isReclaimable } from './room-expiry.js';
import { ClientScriptAssets } from './client-scripts.js';
import { createHttpHandler } from './http-routes.js';
import { dispatchSocketMessage } from './socket-dispatch.js';
import path from 'node:path';

const config = readServerConfig();
const root = path.resolve(import.meta.dir, '../web');
/**
 * The standalone browser scripts are authored as TypeScript and transpiled on
 * demand, so the repository holds no generated JavaScript and cannot drift from
 * source. They are not part of the pinned client, so they live here rather than
 * under `web/`.
 */
const scriptsDirectory = path.resolve(import.meta.dir, '../scripts');
const clientScripts = new ClientScriptAssets(scriptsDirectory);
const store = new RoomStore(
  process.env.BP_DB || path.resolve(import.meta.dir, '../state/rooms.sqlite'),
);
// Test-only fault injection: browser regressions set BP_TEST_FAIL_MAP_FETCH_CALL
// to a comma list of lazy course-load call numbers that must fail. The room's
// loadNext is the only caller, so call 1 is exactly the first next-course load.
const failingMapFetchCalls = new Set(
  (process.env.BP_TEST_FAIL_MAP_FETCH_CALL ?? '')
    .split(',')
    .map(Number)
    .filter((call) => Number.isInteger(call) && call > 0),
);
let mapFetchCalls = 0;
const loadMap = (id: string) => {
  mapFetchCalls += 1;
  if (failingMapFetchCalls.has(mapFetchCalls)) {
    return Promise.reject(new Error('Injected next-course fetch failure'));
  }
  return fetchPublicMap(id, { saved: true });
};
const leaderboard = new Leaderboard(store.db);
const replayArchive = new ReplayArchive(store.db);
const onReplayRound = replayArchive.record.bind(replayArchive);
const playlistJobs = new PlaylistJobs();
const onFinalize = (room: Room) => {
  try {
    leaderboard.record(room);
  } catch (error) {
    console.error('Could not record leaderboard result:', errorMessage(error));
    logEvent('leaderboard_record_failed', { room: room.code });
  }
};
const rooms = store.load(courseIndex, { prepareMatch, loadMap, onFinalize, onReplayRound });
for (const id of courseIndex.keys()) {
  rememberPublicMetadata(id, courseIndex.get(id)?.title);
}
const admin = createAdmin({
  origin: config.canonicalOrigin,
  allowedOrigins: config.allowedOrigins,
  secureCookies: config.canonicalOrigin.startsWith('https:'),
  passwordHash: process.env.BP_ADMIN_PASSWORD_HASH,
  rooms,
  courseCount,
  eventLog: process.env.BP_EVENT_LOG,
});
const handleRequest = createHttpHandler({
  config,
  root,
  rooms,
  roomOptions: {
    prepareMatch,
    loadMap,
    onChange: (room) => store.save(room),
    onFinalize,
    onReplayRound,
  },
  admin,
  databaseStats: () => store.stats(),
  clientScripts,
  leaderboard,
  replayArchive,
  playlistJobs,
});

const server = Bun.serve<{ room: Room; uid: string | null }>({
  hostname: config.hostname,
  port: config.port,
  maxRequestBodySize: MAX_JSON_BODY_BYTES,
  async fetch(req, httpServer) {
    // `undefined` means the WebSocket upgrade took the connection over, which
    // is not a response to decorate.
    const answered = await handleRequest(req, httpServer);
    return answered === undefined
      ? undefined
      : withDeploymentHeaders(answered, { https: config.httpsDeployment });
  },
  websocket: {
    maxPayloadLength: 1024 * 1024,
    idleTimeout: 120,
    open(ws) {
      setTimeout(() => {
        if (!ws.data.uid) {
          ws.close(1008, 'Join required');
        }
      }, 10000);
    },
    message(ws, raw) {
      dispatchSocketMessage(ws, raw);
    },
    close(ws, code) {
      if (ws.data.uid) {
        logEvent('socket_closed', { room: ws.data.room.code, uid: ws.data.uid, code });
      }
      ws.data.room.close(ws);
    },
  },
});
const tick = setInterval(() => {
  for (const room of rooms.values()) {
    room.tick();
  }
}, 100);
// Reclaim empty rooms, including never-joined rooms, after 30 minutes.
// Soak tests set BP_ROOM_IDLE_MS / BP_ROOM_SWEEP_MS to run the same decision on
// a seconds rather than half-hour clock; production keeps the defaults.
const roomIdleLimitMs = Number(process.env.BP_ROOM_IDLE_MS) || ROOM_IDLE_LIMIT_MS;
const reclaimIntervalMs = Number(process.env.BP_ROOM_SWEEP_MS) || 60_000;
const reclaim = setInterval(() => {
  replayArchive.prune();
  const now = Date.now();
  for (const [code, room] of rooms) {
    const connectedPlayers = [...room.players.values()].filter((player) => player.ws).length;
    if (
      isReclaimable({ connectedPlayers, lastActivity: room.lastActivity }, now, roomIdleLimitMs)
    ) {
      room.dispose();
      rooms.delete(code);
      store.remove(code);
    }
  }
}, reclaimIntervalMs);

/**
 * Stop accepting work, settle what is in flight, and release everything this
 * process owns. The order lives in `shutdown.ts`, where it can be asserted; this
 * function only supplies the real resources and decides the exit code.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logEvent('server_stopping', { signal, rooms: rooms.size });
  const result = await shutdownResources(
    {
      stopListener: () => server.stop(),
      rooms: () => rooms.values(),
      checkpoint: (room) => store.save(room),
      disposeRoom: (room) => room.dispose(),
      closeDatabase: () => store.close(),
      cancelTimers: () => {
        clearInterval(tick);
        clearInterval(reclaim);
      },
      log: logEvent,
    },
    signal,
  );
  process.exit(result.ok ? 0 : 1);
}
// `SIGINT` is Ctrl-C and `SIGTERM` is what a service manager sends. Both mean
// the same thing here, so both take the same path.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
    // A stuck step must not keep the process alive past the point where it is
    // useful; the checkpoint above is the only thing that really matters.
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
logEvent('server_started', { hostname: config.hostname, port: config.port });
console.log('Better Party local only:', server.url.href);
