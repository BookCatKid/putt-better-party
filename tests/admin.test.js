import { test, expect } from 'bun:test';
import { createAdmin, adminRoom, recentAdminEvents } from '../src/admin.js';
import { Room } from '../src/room.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const origin = 'https://example.test';
const password = 'test-only-admin-password';
const passwordHash = await Bun.password.hash(password, {
  algorithm: 'argon2id',
  memoryCost: 4096,
  timeCost: 2,
});
const makeAdmin = (options = {}) =>
  createAdmin({
    origin,
    allowedOrigins: [origin],
    secureCookies: true,
    passwordHash,
    rooms: new Map(),
    courseCount: () => 3,
    ...options,
  });
const send = (admin, path, { body, cookie, source = origin } = {}) => {
  const url = '/api/admin/' + path;
  return admin(
    new Request(origin + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: source, ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    url,
  );
};

test('admin status requires a real authenticated session, and logout revokes it', async () => {
  const admin = makeAdmin();
  expect((await send(admin, 'status')).status).toBe(401);
  expect((await send(admin, 'status', { cookie: 'bp_admin=forged' })).status).toBe(401);
  expect(
    (await send(admin, 'login', { body: { password }, source: 'https://other.test' })).status,
  ).toBe(403);
  const login = await send(admin, 'login', { body: { password } });
  expect(login.status).toBe(200);
  const header = login.headers.get('set-cookie');
  expect(header).toContain('HttpOnly');
  expect(header).toContain('SameSite=Strict');
  expect(header).toContain('Secure');
  expect(header).not.toContain(password);
  const cookie = header.split(';')[0];
  const status = await send(admin, 'status', { cookie });
  expect(status.status).toBe(200);
  expect(status.headers.get('cache-control')).toBe('no-store');
  expect(await status.json()).toMatchObject({ rooms: [], maps: 3 });
  expect((await send(admin, 'logout', { cookie, body: {} })).status).toBe(200);
  expect((await send(admin, 'status', { cookie })).status).toBe(401);
});

test('admin login throttles repeated failed guesses and fails closed without configuration', async () => {
  const admin = makeAdmin();
  for (let attempt = 0; attempt < 5; attempt++) {
    expect((await send(admin, 'login', { body: { password: 'wrong' } })).status).toBe(401);
  }
  expect((await send(admin, 'login', { body: { password } })).status).toBe(429);
  expect(
    (await send(makeAdmin({ passwordHash: undefined }), 'login', { body: { password } })).status,
  ).toBe(503);
});
test('admin room projection never includes host capabilities, session secrets or map geometry', () => {
  const room = new Room('ABCDE', new Map());
  const identity = room.issue('Player');
  const playerSocket = { data: {}, send() {}, close() {} };
  room.handle(playerSocket, { t: 'join', ...identity, protocol: 2, host: room.hostToken });
  try {
    const view = adminRoom(room);
    expect(view.connected).toBe(1);
    expect(view.players[0]).toMatchObject({ name: 'Player', isHost: true, connected: true });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(room.hostToken);
    expect(serialized).not.toContain(identity.session);
    expect(serialized).not.toContain(identity.uid);
  } finally {
    room.dispose();
  }
});
test('admin activity projects only explicit safe fields from current and rotated logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bp-admin-events-'));
  const filename = join(directory, 'events.jsonl');
  try {
    await writeFile(
      filename,
      'bad json\n' +
        JSON.stringify({
          event: 'player_joined',
          name: 'Player',
          room: 'ABCDE',
          session: 'secret',
          hostToken: 'other-secret',
          spec: { geometry: true },
        }) +
        '\n',
    );
    await writeFile(
      filename + '.1',
      JSON.stringify({ event: 'match_started', room: 'ABCDE' }) + '\n',
    );
    const events = await recentAdminEvents(filename);
    expect(events).toEqual([
      { event: 'player_joined', name: 'Player', room: 'ABCDE' },
      { event: 'match_started', room: 'ABCDE' },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
