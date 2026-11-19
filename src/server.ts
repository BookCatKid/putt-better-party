import type { Server } from 'bun';
import { ReplayArchive } from './replays.js';
import { Leaderboard } from './leaderboard.js';
import { PlaylistJobs, parseFilters } from './playlist-generator.js';
import { currentDailyNumber, validateCourse } from './upstream/client-adapter.js';
import { createAdmin } from './admin.js';
import { Room } from './room.js';
import { readServerConfig } from './config.js';
import { shutdownResources } from './shutdown.js';
import { logEvent } from './event-log.js';
import { withDeploymentHeaders } from './deployment-headers.js';
import { RoomStore } from './room-store.js';
import { courseIndex, courseCount, fetchPublicMap, prepareMatch } from './catalog.js';
import { errorMessage, MAP_SOURCE } from './domain.js';
import {
  browse,
  detail,
  publicStats,
  preview,
  rememberPublicMetadata,
  upstreamMetrics,
} from './upstream.js';
import {
  MAX_JSON_BODY_BYTES,
  SizeLimitExceededError,
  assertResponseWithinLimit,
  containedAssetPath,
  decodedPathSegment,
  isPublicCourseId,
  isReadMethod,
  isRoomCode,
  isWriteMethod,
  parsePublicCourseIdList,
  readJsonObject,
} from './request-guards.js';
import { ClientScriptAssets } from './client-scripts.js';
import { readClientBuild } from './client-build.js';
import { VERSION } from './version.js';
import { randomInt } from 'node:crypto';
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
const response = (data: unknown, status = 200) => Response.json(data, { status });
const origin = config.canonicalOrigin;
const READ_METHODS = ['GET', 'HEAD'] as const;
const WRITE_METHODS = ['POST'] as const;
const methodNotAllowed = (allowed: readonly string[]) =>
  new Response('Method not allowed', {
    status: 405,
    headers: { allow: allowed.join(', ') },
  });
/**
 * Content Security Policy, directive by directive. Every relaxation below was
 * read off what the pinned original client actually loads, so none of them can
 * be dropped without breaking the game:
 *
 * - `default-src 'self' data: blob:` — the fallback for anything not named
 *   below; `data:` and `blob:` cover generated textures and the module worker.
 * - `script-src 'unsafe-inline'` — the original bundles inject module scripts.
 * - `script-src 'unsafe-eval'` — the bundle's scene/physics code is compiled by
 *   its bundler's dynamic-evaluation path.
 * - `script-src 'wasm-unsafe-eval' blob:` — Draco and meshopt ship WebAssembly
 *   decoders and their worker is created from a `blob:` URL.
 * - `style-src 'unsafe-inline'` — React sets inline `style` attributes.
 * - `img-src 'self' data: blob:` — thumbnails come from `/api/preview`, and
 *   generated art arrives as `data:`/`blob:` URLs.
 * - `connect-src 'self' <ws origin>` — HTTP calls and the party WebSocket are
 *   both same-origin; the WebSocket scheme must be listed separately.
 * - `worker-src 'self' blob:` — the decoders run in blob workers.
 * - `font-src 'self' data:` — the UI font is served from `/assets`.
 * - `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'` — nothing
 *   embeds a plugin, rewrites the base URL or frames the page.
 */
const csp =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' " +
  config.websocketOrigins.join(' ') +
  "; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const admin = createAdmin({
  origin,
  allowedOrigins: config.allowedOrigins,
  secureCookies: config.canonicalOrigin.startsWith('https:'),
  passwordHash: process.env.BP_ADMIN_PASSWORD_HASH,
  rooms,
  courseCount,
  eventLog: process.env.BP_EVENT_LOG,
});
const page = (markup: string) =>
  new Response(markup, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp,
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
const html =
  '<!doctype html><html lang="en" class="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Party · Better Party</title><link rel="icon" href="/favicon.ico" type="image/x-icon"><link rel="stylesheet" href="/assets/styles-S28F_fms.css"><body class="bp-page"><div id="app"></div><script type="module" src="/assets/index-DFMxt6BL.js"></script></body></html>';
/**
 * Answer one HTTP request. Split out of the `Bun.serve` literal so the
 * deployment headers can be applied once, around whatever it returns.
 */
async function handleRequest(
  req: Request,
  httpServer: Server<{ room: Room; uid: string | null }>,
): Promise<Response | undefined> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  if (!config.allowedHosts.includes(req.headers.get('host') ?? '')) {
    return new Response('Invalid host', { status: 403 });
  }
  // Every route is a read or a create: an unexpected verb (PUT, DELETE, PATCH,
  // OPTIONS) must not fall through to a path-only test and be answered as if it
  // were a read.
  if (!isReadMethod(req.method) && !isWriteMethod(req.method)) {
    return methodNotAllowed([...READ_METHODS, ...WRITE_METHODS]);
  }
  const readOnly = isReadMethod(req.method);
  if (pathname.startsWith('/ws/party/')) {
    if (!readOnly) {
      return methodNotAllowed(READ_METHODS);
    }
    const code = decodedPathSegment(pathname.slice('/ws/party/'.length));
    const room = isRoomCode(code) ? rooms.get(code) : undefined;
    if (!room || !config.allowedOrigins.includes(req.headers.get('origin') ?? '')) {
      return new Response('Room not found or invalid origin', { status: 403 });
    }
    return httpServer.upgrade(req, { data: { room, uid: null } })
      ? undefined
      : new Response('Bad upgrade', { status: 400 });
  }
  if (pathname === '/favicon.ico') {
    if (!readOnly) {
      return methodNotAllowed(READ_METHODS);
    }
    const favicon = containedAssetPath(root, pathname);
    return favicon
      ? new Response(Bun.file(favicon), {
          headers: {
            'content-type': 'image/x-icon',
            'cache-control': 'public, max-age=3600',
            'x-content-type-options': 'nosniff',
          },
        })
      : new Response('Not found', { status: 404 });
  }
  if (pathname === '/health') {
    if (!readOnly) {
      return methodNotAllowed(READ_METHODS);
    }
    // Enough to answer "is it healthy, and is upstream the problem?" without
    // exposing anything a caller could not already see. Counts and durations
    // only: no room code, course, player name or credential appears here, since
    // a health endpoint is often the least protected surface on a service.
    const memory = process.memoryUsage();
    let connectedPlayers = 0;
    let activeMatches = 0;
    for (const room of rooms.values()) {
      for (const player of room.players.values()) {
        if (player.ws) {
          connectedPlayers += 1;
        }
      }
      if (room.phase !== 'lobby') {
        activeMatches += 1;
      }
    }
    return response({
      ok: true,
      version: VERSION,
      client: await readClientBuild(root),
      rooms: rooms.size,
      maps: courseCount(),
      players: connectedPlayers,
      activeMatches,
      uptimeSeconds: Math.round(process.uptime()),
      memory: {
        // Heap is the number that matters for leak detection; RSS includes
        // memory we cannot release anyway.
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
      },
      upstream: upstreamMetrics(),
    });
  }
  if (req.method === 'POST' && !config.allowedOrigins.includes(req.headers.get('origin') ?? '')) {
    return response({ error: 'Invalid origin' }, 403);
  }
  try {
    if (pathname.startsWith('/api/admin/')) {
      return await admin(req, pathname);
    }
    if (pathname === '/admin') {
      if (!readOnly) {
        return methodNotAllowed(READ_METHODS);
      }
      return new Response(Bun.file(new URL('./admin.html', import.meta.url)), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy':
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
          'referrer-policy': 'no-referrer',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'x-robots-tag': 'noindex, nofollow',
        },
      });
    }
    if (pathname === '/admin.css') {
      if (!readOnly) {
        return methodNotAllowed(READ_METHODS);
      }
      return new Response(Bun.file(new URL('./admin.css', import.meta.url)), {
        headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
      });
    }
    if (
      pathname === '/admin.js' ||
      pathname === '/assets/bp-home.js' ||
      pathname === '/assets/bp-leaderboard.js'
    ) {
      if (!readOnly) {
        return methodNotAllowed(READ_METHODS);
      }
      const asset = pathname.startsWith('/assets/')
        ? pathname.slice('/assets/'.length)
        : pathname.slice(1);
      const javascript = await clientScripts.javascriptFor(asset);
      if (javascript === null) {
        return new Response('Not found', { status: 404 });
      }
      return new Response(javascript, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    }
    if (pathname === '/api/create') {
      if (req.method !== 'POST') {
        return methodNotAllowed(WRITE_METHODS);
      }
      if (rooms.size >= 100) {
        return response({ error: 'Room limit reached' }, 429);
      }
      let code;
      do {
        code = Array.from(
          { length: 5 },
          () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)],
        ).join('');
      } while (rooms.has(code));
      const room = new Room(code, courseIndex, {
        prepareMatch,
        loadMap,
        onChange: (changedRoom) => store.save(changedRoom),
        onFinalize,
        onReplayRound,
      });
      rooms.set(code, room);
      store.save(room);
      logEvent('room_created', { room: room.code });
      return response({ code, hostToken: room.hostToken });
    }
    if (pathname.startsWith('/api/room/')) {
      if (!readOnly) {
        return methodNotAllowed(READ_METHODS);
      }
      const code = decodedPathSegment(pathname.slice('/api/room/'.length));
      const room = isRoomCode(code) ? rooms.get(code) : undefined;
      return room
        ? response({
            code: room.code,
            phase: room.phase,
            locked: room.config.locked,
            players: room.roster().length,
          })
        : response({ error: 'Room does not exist' }, 404);
    }
    if (pathname === '/api/join') {
      if (req.method !== 'POST') {
        return methodNotAllowed(WRITE_METHODS);
      }
      const requestBody = await readJsonObject(req);
      const room = isRoomCode(requestBody.code) ? rooms.get(requestBody.code) : undefined;
      if (!room) {
        return response({ error: 'Room does not exist' }, 404);
      }
      return response(
        room.issue(requestBody.name, requestBody.uid, requestBody.session, requestBody.ball),
      );
    }
    if (pathname === '/api/import' || pathname === '/api/import-playlist') {
      if (req.method !== 'POST') {
        return methodNotAllowed(WRITE_METHODS);
      }
      const requestBody = await readJsonObject(req);
      const room = isRoomCode(requestBody.code) ? rooms.get(requestBody.code) : undefined;
      const player = room?.players.get(typeof requestBody.uid === 'string' ? requestBody.uid : '');
      const allowed = () =>
        room &&
        room.phase === 'lobby' &&
        !room.starting &&
        room.hostUid === requestBody.uid &&
        player?.ws &&
        requestBody.host === room.hostToken &&
        requestBody.session === room.issued.get(player.uid)?.session;
      if (!room || !player?.ws || !allowed()) {
        return response({ error: 'Only a connected lobby host may import maps' }, 403);
      }
      if (pathname === '/api/import') {
        if (!isPublicCourseId(requestBody.id)) {
          return response({ error: 'Invalid course ID' }, 400);
        }
        const { spec: _spec, ...meta } = await fetchPublicMap(requestBody.id, {
          saved: requestBody.saved === true,
        });
        assertResponseWithinLimit(meta);
        logEvent('course_imported', { room: room.code, uid: player.uid, courseId: meta.id });
        return response(meta);
      }
      let playlistIds: string[];
      try {
        playlistIds = parsePublicCourseIdList(requestBody.ids);
      } catch (error) {
        return response({ error: errorMessage(error) }, 400);
      }
      const items = [];
      const configurationRevision = room.configRevision;
      for (const id of new Set<string>(playlistIds)) {
        items.push(await fetchPublicMap(id, { saved: true }));
      }
      if (!allowed()) {
        return response({ error: 'The lobby changed while loading the playlist' }, 409);
      }
      // The playlist was computed across an await, so between `allowed()` above
      // and here the host may have edited the configuration. Applying the result
      // regardless would silently discard that edit while reporting success.
      if (!room.applyPlaylist(player.ws, playlistIds, configurationRevision)) {
        return response({ error: 'Settings changed while the playlist was loading' }, 409);
      }
      logEvent('playlist_imported', {
        room: room.code,
        uid: player.uid,
        courses: items.map(({ id }) => id),
      });
      const playlistMeta = items.map(({ spec, ...meta }) => meta);
      assertResponseWithinLimit(playlistMeta);
      return response({ holes: playlistMeta });
    }
    if (pathname === '/api/generate-playlist' && req.method === 'POST') {
      const body = await readJsonObject(req);
      const room = rooms.get(typeof body.code === 'string' ? body.code : '');
      const player = room?.players.get(typeof body.uid === 'string' ? body.uid : '');
      const authorized = () =>
        room &&
        player?.ws &&
        room.hostUid === player.uid &&
        body.host === room.hostToken &&
        body.session === room.issued.get(player.uid)?.session &&
        room.players.get(player.uid) === player;
      if (!room || !player || !authorized()) {
        return response({ error: 'Only a connected host may generate playlists' }, 403);
      }
      if (body.action === 'status') {
        return response(playlistJobs.get(room.code));
      }
      if (body.action === 'cancel') {
        return response(playlistJobs.cancel(room.code));
      }
      if (
        body.action !== 'start' ||
        room.phase !== 'lobby' ||
        room.starting ||
        room.config.mapSource !== MAP_SOURCE.PICKED
      ) {
        return response({ error: 'Choose a custom playlist in the lobby first' }, 409);
      }
      const filters = parseFilters(body.filters);
      const configuration = room.config;
      const allowed = () =>
        !!authorized() &&
        !room.closed &&
        room.phase === 'lobby' &&
        !room.starting &&
        room.config === configuration;
      const job = playlistJobs.start(
        room.code,
        filters,
        {
          browse,
          excludeIds:
            filters.mode === 'append' ? new Set(configuration.selectedHoleIds) : undefined,
          stats: publicStats,
          currentDay: currentDailyNumber,
          allowed,
          specification: async (id) => {
            const course = await detail(id);
            return validateCourse(course.spec, course.title);
          },
        },
        (holes) => {
          for (const hole of holes) {
            courseIndex.set(hole.id, { id: hole.id, title: hole.title });
          }
          const ids = holes.map((hole) => hole.id);
          const selected =
            filters.mode === 'append'
              ? [
                  ...configuration.selectedHoleIds,
                  ...ids.filter((id) => !configuration.selectedHoleIds.includes(id)),
                ]
              : ids;
          room.configure(player.ws!, { mapSource: MAP_SOURCE.PICKED, selectedHoleIds: selected });
          logEvent('playlist_generated', { room: room.code, count: selected.length });
        },
      );
      return response(job);
    }
    if (pathname.startsWith('/api/replays/')) {
      if (!readOnly) {
        return methodNotAllowed(READ_METHODS);
      }
      const match = /^\/api\/replays\/([A-Za-z0-9_-]{32})(?:\/(\d{1,5}))?$/.exec(pathname);
      if (!match) {
        return response({ error: 'Replay not found' }, 404);
      }
      if (match[2] !== undefined) {
        const round = replayArchive.round(match[1], Number(match[2]));
        return round
          ? new Response(round, {
              headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
            })
          : response({ error: 'Replay not found or expired' }, 404);
      }
      const summary = replayArchive.summary(match[1]);
      return summary ? response(summary) : response({ error: 'Replay not found or expired' }, 404);
    }
    if (/^\/replays\/[A-Za-z0-9_-]{32}$/.test(pathname)) {
      if (!readOnly) {
        return methodNotAllowed(READ_METHODS);
      }
      return page(html.replace('Party · Better Party', 'Replays · Better Party'));
    }
    if (pathname === '/api/leaderboard' && req.method === 'GET') {
      const holes = Number(url.searchParams.get('holes') ?? 3);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (
        !Number.isInteger(holes) ||
        holes < 1 ||
        holes > 9 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 100000
      ) {
        return response({ error: 'Invalid leaderboard selection' }, 400);
      }
      return response(
        leaderboard.list(holes, (url.searchParams.get('search') ?? '').slice(0, 24), offset),
      );
    }
    if (pathname === '/leaderboard' && req.method === 'GET') {
      return page(await Bun.file(new URL('./leaderboard.html', import.meta.url)).text());
    }
    if (pathname === '/api/catalog') {
      if (!readOnly) {
        return methodNotAllowed(READ_METHODS);
      }
      const catalogPage = await browse(Object.fromEntries(url.searchParams));
      // A relay of an upstream page: bounded rather than trusted, because the
      // field lengths upstream are not ours to control.
      assertResponseWithinLimit(catalogPage);
      return response(catalogPage);
    }

    if (pathname.startsWith('/api/preview/')) {
      if (!readOnly) {
        return methodNotAllowed(READ_METHODS);
      }
      const courseId = decodedPathSegment(pathname.slice('/api/preview/'.length));
      if (!isPublicCourseId(courseId)) {
        return response({ error: 'Invalid course ID' }, 400);
      }
      return await preview(courseId);
    }
    if (pathname.startsWith('/api/map/')) {
      if (!readOnly) {
        return methodNotAllowed(READ_METHODS);
      }
      const courseId = decodedPathSegment(pathname.slice('/api/map/'.length));
      const course = isPublicCourseId(courseId) ? courseIndex.get(courseId) : undefined;
      return course?.spec ? response(course) : response({ error: 'Map missing' }, 404);
    }
    if (pathname === '/home' || pathname === '/') {
      if (!readOnly) {
        return methodNotAllowed(READ_METHODS);
      }
      return page(await Bun.file(new URL('./home.html', import.meta.url)).text());
    }
    if (pathname === '/party') {
      if (!readOnly) {
        return methodNotAllowed(READ_METHODS);
      }
      return page(await Bun.file(new URL('./home.html', import.meta.url)).text());
    }
    if (/^\/party\/[A-Z2-9]{5}$/.test(pathname)) {
      if (!readOnly) {
        return methodNotAllowed(READ_METHODS);
      }
      return page(html);
    }
    if (pathname.startsWith('/_serverFn/')) {
      logEvent('official_api_blocked', {
        functionId: /^\/_serverFn\/[a-f0-9]{64}$/.test(pathname)
          ? pathname.slice('/_serverFn/'.length)
          : 'invalid',
      });
      console.log('Blocked unrelated official server function', pathname);
      return response({ error: 'Official API disabled' }, 404);
    }
    if (/^\/(assets|models|sfx|sky)\//.test(pathname)) {
      if (!readOnly) {
        return methodNotAllowed(READ_METHODS);
      }
      const asset = containedAssetPath(root, pathname);
      if (asset) {
        return new Response(Bun.file(asset), {
          headers: { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' },
        });
      }
      logEvent('asset_missing', {
        path: /^\/(assets|models|sfx|sky)\/[a-zA-Z0-9_./-]{1,200}$/.test(pathname)
          ? pathname
          : 'invalid-path',
      });
      console.log('Missing asset', pathname);
      return new Response('Missing asset', { status: 404 });
    }
    return new Response('Not found', { status: 404 });
  } catch (error) {
    logEvent('http_request_failed', {
      route: [
        '/api/join',
        '/api/create',
        '/api/import',
        '/api/import-playlist',
        '/api/catalog',
      ].includes(pathname)
        ? pathname
        : 'other',
      method: req.method,
    });
    if (error instanceof SizeLimitExceededError) {
      return response({ error: errorMessage(error) }, error.status);
    }
    return response({ error: errorMessage(error) }, 400);
  }
}

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
      try {
        ws.data.room.handle(ws, JSON.parse(raw.toString()));
      } catch (error) {
        ws.data.room.error(ws, 'bad-message', 'Invalid message');
        console.error(errorMessage(error));
      }
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
const reclaim = setInterval(() => {
  replayArchive.prune();
  for (const [code, room] of rooms) {
    if (
      ![...room.players.values()].some((player) => player.ws) &&
      Date.now() - room.lastActivity > 1800000
    ) {
      room.dispose();
      rooms.delete(code);
      store.remove(code);
    }
  }
}, 60000);

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
