import { randomBytes } from 'node:crypto';
import { isRecord } from './domain.js';
import type { Room } from './room.js';

const SESSION_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_LIMIT = 5;
const COOKIE = 'bp_admin';
const EVENT_FIELDS = [
  'timestamp',
  'event',
  'room',
  'name',
  'phase',
  'holeIndex',
  'strokes',
  'timeMs',
  'previous',
  'courseTitle',
  'title',
  'par',
  'role',
  'code',
  'action',
  'accepted',
  'returning',
  'reload',
  'deliberate',
  'reason',
  'status',
  'awaitingPlayers',
  'precedingDroppedEvents',
] as const;

function reply(data: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(data, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  });
}

/** Explicit projection: never serialize a room, checkpoint, or raw credential. */
export function adminRoom(room: Room) {
  return {
    code: room.code,
    phase: room.phase,
    preparing: room.starting || room.loadingNext,
    connected: [...room.players.values()].filter((player) => player.ws).length,
    players: room.roster().map(({ uid, ...player }) => ({
      name: player.name,
      role: player.role,
      connected: player.connected,
      isHost: player.isHost,
      ready: player.ready,
      alive: player.alive,
      strokes: room.players.get(uid)?.strokes ?? 0,
      totalStrokes: room.players.get(uid)?.totalStrokes ?? 0,
      totalTimeMs: room.players.get(uid)?.totalTimeMs ?? 0,
      holeTimeMs: room.players.get(uid)?.holeTimeMs ?? null,
      holesSurvived: room.players.get(uid)?.holesSurvived ?? 0,
    })),
    currentHole: room.phase === 'lobby' ? null : room.holeIndex + 1,
    course: room.specs[room.holeIndex]?.name ?? null,
    holes: room.config.holes,
    timerEndsAt: room.phase === 'playing' ? room.startsAt + room.roundTimerMs : null,
    elimination: room.config.elimination,
    locked: room.config.locked,
    lateJoin: room.config.lateJoin,
    courseVoting: room.config.courseVoting,
    vote: room.voteSnapshot()?.choices.map(({ title, votes }) => ({ title, votes })) ?? null,
    lastActivity: room.lastActivity,
    rounds: room.roundHistory.map((round) => ({
      hole: round.index + 1,
      title: round.title,
      par: round.par,
      status: round.status,
      completed: round.rows.filter((row) => row.status === 'holed').length,
      scores: round.rows.map(({ uid, strokes, status, timeMs }) => ({
        name: room.players.get(uid)?.name ?? 'Departed player',
        strokes,
        status,
        timeMs,
      })),
    })),
  };
}

/** Read a bounded recent tail of the existing private event log. */
export async function recentAdminEvents(filename?: string) {
  const result: Record<string, unknown>[] = [];
  if (!filename) {
    return result;
  }
  for (let index = 0; index <= 6 && result.length < 500; index++) {
    const file = Bun.file(filename + (index ? '.' + index : ''));
    try {
      if (!(await file.exists())) {
        continue;
      }
      const start = Math.max(0, file.size - 1024 * 1024);
      const lines = (await file.slice(start).text()).split('\n');
      if (start) {
        lines.shift();
      }
      for (const line of lines.reverse()) {
        if (result.length >= 500) {
          break;
        }
        try {
          const entry: unknown = JSON.parse(line);
          if (!isRecord(entry) || typeof entry.event !== 'string') {
            continue;
          }
          const safe: Record<string, unknown> = {};
          for (const field of EVENT_FIELDS) {
            const value = entry[field];
            if (
              typeof value === 'string' ||
              typeof value === 'number' ||
              typeof value === 'boolean'
            ) {
              safe[field] = value;
            }
          }
          result.push(safe);
        } catch {
          // A partial or malformed log line is not an event.
        }
      }
    } catch {
      // Rotation may move a file between the existence check and read.
    }
  }
  return result;
}

export function createAdmin({
  origin,
  passwordHash,
  rooms,
  courseCount,
  eventLog,
}: {
  origin: string;
  passwordHash?: string;
  rooms: Map<string, Room>;
  courseCount: () => number;
  eventLog?: string;
}) {
  const sessions = new Map<string, number>();
  let failures: number[] = [];
  let verifying = false;
  const cookie = (token: string, maxAge: number) =>
    COOKIE +
    '=' +
    token +
    '; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=' +
    maxAge +
    (origin.startsWith('https:') ? '; Secure' : '');
  const session = (request: Request) =>
    request.headers
      .get('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(COOKIE + '='))
      ?.slice(COOKIE.length + 1) ?? '';
  let eventCache: { at: number; result: ReturnType<typeof recentAdminEvents> } | undefined;

  return async (request: Request, pathname: string): Promise<Response> => {
    if (!passwordHash) {
      return reply({ error: 'Admin is not configured.' }, 503);
    }
    const now = Date.now();
    for (const [token, expires] of sessions) {
      if (expires <= now) {
        sessions.delete(token);
      }
    }
    if (request.method !== 'GET' && request.headers.get('origin') !== origin) {
      return reply({ error: 'Invalid origin.' }, 403);
    }
    if (pathname === '/api/admin/login' && request.method === 'POST') {
      failures = failures.filter((at) => now - at < LOGIN_WINDOW_MS);
      if (verifying || failures.length >= LOGIN_LIMIT) {
        return reply({ error: 'Too many attempts. Try again in a minute.' }, 429, {
          'retry-after': '60',
        });
      }
      verifying = true;
      try {
        const raw = await request.text();
        if (raw.length > 4096) {
          return reply({ error: 'Invalid login.' }, 400);
        }
        const body: unknown = JSON.parse(raw);
        const password = isRecord(body) ? body.password : undefined;
        if (
          typeof password !== 'string' ||
          !password ||
          password.length > 256 ||
          !(await Bun.password.verify(password, passwordHash))
        ) {
          failures.push(now);
          return reply({ error: 'Incorrect password.' }, 401);
        }
        sessions.delete(session(request));
        const token = randomBytes(32).toString('hex');
        while (sessions.size >= 32) {
          const oldest = sessions.keys().next().value;
          if (oldest === undefined) {
            break;
          }
          sessions.delete(oldest);
        }
        sessions.set(token, Date.now() + SESSION_MS);
        failures = [];
        return reply({ ok: true }, 200, { 'set-cookie': cookie(token, SESSION_MS / 1000) });
      } catch {
        failures.push(now);
        return reply({ error: 'Unable to unlock.' }, 400);
      } finally {
        verifying = false;
      }
    }
    const token = session(request);
    if (!sessions.has(token)) {
      return reply({ error: 'Unlock the admin dashboard first.' }, 401);
    }
    if (pathname === '/api/admin/logout' && request.method === 'POST') {
      sessions.delete(token);
      return reply({ ok: true }, 200, { 'set-cookie': cookie('', 0) });
    }
    if (pathname === '/api/admin/status' && request.method === 'GET') {
      const activeRooms = [...rooms.values()]
        .map(adminRoom)
        .sort(
          (left, right) =>
            right.connected - left.connected || right.lastActivity - left.lastActivity,
        );
      if (!eventCache || now - eventCache.at >= 3000) {
        eventCache = { at: now, result: recentAdminEvents(eventLog) };
      }
      return reply({
        now,
        uptime: process.uptime(),
        rooms: activeRooms,
        maps: courseCount(),
        loggingEnabled: !!eventLog,
        events: await eventCache.result,
      });
    }
    return reply({ error: 'Not found.' }, 404);
  };
}
