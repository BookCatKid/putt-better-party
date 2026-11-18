import { Leaderboard } from './leaderboard.js';
import { PlaylistJobs, parseFilters } from './playlist-generator.js';
import { currentDailyNumber, validateCourse } from './upstream/client-adapter.js';
import { createAdmin } from './admin.js';
import { Room } from './room.js';
import { logEvent } from './event-log.js';
import { RoomStore } from './room-store.js';
import { courseIndex, courseCount, fetchPublicMap, prepareMatch } from './catalog.js';
import { isRecord, errorMessage, MAP_SOURCE } from './domain.js';
import { browse, detail, publicStats, preview, rememberPublicMetadata } from './upstream.js';
import { randomInt } from 'node:crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';

const port = Number(process.env.PORT || 8789);
const root = path.resolve(import.meta.dir, '../web');
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
const playlistJobs = new PlaylistJobs();
const onFinalize = (room: Room) => {
  try {
    leaderboard.record(room);
  } catch (error) {
    console.error('Could not record leaderboard result:', errorMessage(error));
    logEvent('leaderboard_record_failed', { room: room.code });
  }
};
const rooms = store.load(courseIndex, { prepareMatch, loadMap, onFinalize });
for (const id of courseIndex.keys()) {
  rememberPublicMetadata(id, courseIndex.get(id)?.title);
}
const response = (data: unknown, status = 200) => Response.json(data, { status });
const origin = new URL(process.env.BP_PUBLIC_ORIGIN ?? 'http://127.0.0.1:' + port).origin;
const admin = createAdmin({
  origin,
  passwordHash: process.env.BP_ADMIN_PASSWORD_HASH,
  rooms,
  courseCount,
  eventLog: process.env.BP_EVENT_LOG,
});
const csp =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' " +
  origin.replace(/^http/, 'ws') +
  "; worker-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const page = (markup: string) =>
  new Response(markup, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp,
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    },
  });
const jsonBody = async (request: Request): Promise<Record<string, unknown>> => {
  if (Number(request.headers.get('content-length')) > 1000000) {
    throw new Error('Request too large');
  }
  const data: unknown = await request.json();
  if (!isRecord(data)) {
    throw new Error('Expected a JSON object');
  }
  return data;
};
const html =
  '<!doctype html><html lang="en" class="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Party · Better Party</title><link rel="icon" href="/favicon.ico" type="image/x-icon"><link rel="stylesheet" href="/assets/styles-S28F_fms.css"><body class="bp-page"><div id="app"></div><script type="module" src="/assets/index-DFMxt6BL.js"></script></body></html>';
const server = Bun.serve<{ room: Room; uid: string | null }>({
  hostname: '127.0.0.1',
  port,
  maxRequestBodySize: 1024 * 1024,
  async fetch(req, httpServer) {
    const url = new URL(req.url);
    const pathname = url.pathname;
    if (req.headers.get('host') !== new URL(origin).host) {
      return new Response('Invalid host', { status: 403 });
    }
    if (pathname.startsWith('/ws/party/')) {
      const room = rooms.get(pathname.split('/').at(-1) ?? '');
      if (!room || req.headers.get('origin') !== origin) {
        return new Response('Room not found or invalid origin', { status: 403 });
      }
      return httpServer.upgrade(req, { data: { room, uid: null } })
        ? undefined
        : new Response('Bad upgrade', { status: 400 });
    }
    if (pathname === '/favicon.ico') {
      return new Response(Bun.file(path.join(root, 'favicon.ico')), {
        headers: {
          'content-type': 'image/x-icon',
          'cache-control': 'public, max-age=3600',
          'x-content-type-options': 'nosniff',
        },
      });
    }
    if (pathname === '/health') {
      return response({ ok: true, rooms: rooms.size, maps: courseCount() });
    }
    if (req.method === 'POST' && req.headers.get('origin') !== origin) {
      return response({ error: 'Invalid origin' }, 403);
    }
    try {
      if (pathname.startsWith('/api/admin/')) {
        return await admin(req, pathname);
      }
      if (req.method === 'GET' && pathname === '/admin') {
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
      if (req.method === 'GET' && (pathname === '/admin.css' || pathname === '/admin.js')) {
        const file =
          pathname === '/admin.css'
            ? new URL('./admin.css', import.meta.url)
            : new URL('../scripts/admin.js', import.meta.url);
        return new Response(Bun.file(file), {
          headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
        });
      }
      if (pathname === '/api/create' && req.method === 'POST') {
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
        });
        rooms.set(code, room);
        store.save(room);
        logEvent('room_created', { room: room.code });
        return response({ code, hostToken: room.hostToken });
      }
      if (pathname.startsWith('/api/room/') && req.method === 'GET') {
        const room = rooms.get(pathname.slice(10));
        return room
          ? response({
              code: room.code,
              phase: room.phase,
              locked: room.config.locked,
              players: room.roster().length,
            })
          : response({ error: 'Room does not exist' }, 404);
      }
      if (pathname === '/api/join' && req.method === 'POST') {
        const requestBody = await jsonBody(req);
        const room = rooms.get(typeof requestBody.code === 'string' ? requestBody.code : '');
        if (!room) {
          return response({ error: 'Room does not exist' }, 404);
        }
        return response(room.issue(requestBody.name, requestBody.uid, requestBody.session));
      }
      if (
        (pathname === '/api/import' || pathname === '/api/import-playlist') &&
        req.method === 'POST'
      ) {
        const requestBody = await jsonBody(req);
        const room = rooms.get(typeof requestBody.code === 'string' ? requestBody.code : '');
        const player = room?.players.get(
          typeof requestBody.uid === 'string' ? requestBody.uid : '',
        );
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
          if (typeof requestBody.id !== 'string') {
            return response({ error: 'Invalid course ID' }, 400);
          }
          const { spec: _spec, ...meta } = await fetchPublicMap(requestBody.id, {
            saved: requestBody.saved === true,
          });
          logEvent('course_imported', { room: room.code, uid: player.uid, courseId: meta.id });
          return response(meta);
        }
        if (
          !Array.isArray(requestBody.ids) ||
          requestBody.ids.length < 1 ||
          requestBody.ids.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{5,64}$/.test(id))
        ) {
          return response({ error: 'Invalid saved playlist' }, 400);
        }
        const items = [];
        for (const id of new Set<string>(requestBody.ids)) {
          items.push(await fetchPublicMap(id, { saved: true }));
        }
        if (!allowed()) {
          return response({ error: 'The lobby changed while loading the playlist' }, 409);
        }
        room.configure(player.ws, {
          mapSource: MAP_SOURCE.PICKED,
          selectedHoleIds: requestBody.ids,
          holes: requestBody.ids.length,
        });
        logEvent('playlist_imported', {
          room: room.code,
          uid: player.uid,
          courses: items.map(({ id }) => id),
        });
        return response({ holes: items.map(({ spec, ...meta }) => meta) });
      }
      if (pathname === '/api/generate-playlist' && req.method === 'POST') {
        const body = await jsonBody(req);
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
        const catalogPage = await browse(Object.fromEntries(url.searchParams));
        return response(catalogPage);
      }

      if (pathname.startsWith('/api/preview/') && req.method === 'GET') {
        return await preview(decodeURIComponent(pathname.slice(13)));
      }
      if (pathname.startsWith('/api/map/')) {
        const course = courseIndex.get(decodeURIComponent(pathname.slice(9)));
        return course?.spec ? response(course) : response({ error: 'Map missing' }, 404);
      }
      if (pathname === '/home' || pathname === '/') {
        return page(await Bun.file(new URL('./home.html', import.meta.url)).text());
      }
      if (pathname === '/party') {
        return page(await Bun.file(new URL('./home.html', import.meta.url)).text());
      }
      if (/^\/party\/[A-Z2-9]{5}$/.test(pathname)) {
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
        const full = path.resolve(root, '.' + decodeURIComponent(pathname));
        if (full.startsWith(root + '/') && existsSync(full)) {
          return new Response(Bun.file(full), {
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
      return response({ error: errorMessage(error) }, 400);
    }
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
setInterval(() => {
  for (const room of rooms.values()) {
    room.tick();
  }
}, 100);
// Reclaim empty rooms, including never-joined rooms, after 30 minutes.
setInterval(() => {
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
logEvent('server_started', { port });
console.log('Better Party local only:', server.url.href);
