import { test, expect } from 'bun:test';
import { Room } from '../src/room.js';

/**
 * Late admission across the three policies, and what a disconnect means.
 *
 * The policies are the host's choice and they differ in one thing only: *when* a
 * newcomer becomes a player. Fairness is the constraint that matters - a late
 * arrival can score the holes they play and nothing before them, and no policy may
 * let an existing score be rewritten.
 */

const spec = { id: 'public-level', name: 'Example', par: 3 };
const maps = new Map([
  ['p', { id: 'p', spec }],
  ['q', { id: 'q', spec: { ...spec, id: 'next', par: 2 } }],
]);
const socket = () => ({
  data: {},
  frames: [],
  send(serializedMessage) {
    this.frames.push(JSON.parse(serializedMessage));
  },
  close() {
    this.closed = true;
  },
});
const enter = (room, name, host = false) => {
  const identity = room.issue(name);
  const ws = socket();
  room.handle(ws, {
    t: 'join',
    ...identity,
    protocol: 2,
    ...(host ? { host: room.hostToken } : {}),
  });
  return { ws, identity, player: room.players.get(identity.uid) };
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForRoom(condition, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Room did not reach the expected state');
    }
    await delay(5);
  }
}

async function startedRoom(config) {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const host = enter(room, 'Host', true);
  room.handle(host.ws, {
    t: 'config',
    config: {
      mapSource: 'picked',
      selectedHoleIds: ['p', 'q'],
      elimination: false,
      ...config,
    },
  });
  room.handle(host.ws, { t: 'start' });
  await waitForRoom(() => room.phase === 'playing');
  return { room, host };
}

test('always admits a newcomer mid-hole, who scores only the hole they play', async () => {
  const { room, host } = await startedRoom({ lateJoin: 'always' });
  try {
    const late = enter(room, 'Late');
    // Admitted at once rather than waiting for a hole boundary.
    expect(late.player.role).toBe('player');
    expect(late.player.participated).toBe(true);
    expect(late.player.holesSurvived).toBe(0);

    room.handle(host.ws, { f: 1, s: 2, p: 3 });
    room.handle(late.ws, { f: 1, s: 1, p: 3 });
    await waitForRoom(() => room.holeIndex === 1 && room.phase === 'playing');

    // The scorecard records both, and neither earlier score is touched.
    expect(room.roundHistory[0].rows).toEqual([
      { uid: host.identity.uid, strokes: 2, status: 'holed', timeMs: expect.any(Number) },
      { uid: late.identity.uid, strokes: 1, status: 'holed', timeMs: expect.any(Number) },
    ]);
    expect(host.player.totalStrokes).toBe(2);
    // Only the hole they actually played counts toward the newcomer.
    expect(late.player.totalStrokes).toBe(1);
    expect(late.player.holesSurvived).toBe(1);
    // Fairness: a better score on the one hole played ranks above the host.
    expect(room.standings().map((row) => row.name)).toEqual(['Late', 'Host']);
  } finally {
    room.dispose();
  }
});

test('always does not admit a newcomer whose arrival is too late for the hole', async () => {
  // With a round timer, "always" still means "this hole, while it is still open".
  // A player who arrives after the deadline is not given a score they could not
  // have earned, so they wait for the next hole like the next-hole policy.
  const { room } = await startedRoom({ lateJoin: 'always', timerMs: 1000 });
  try {
    room.startsAt = Date.now() - 2000;
    const late = enter(room, 'Late');
    expect(late.player.role).toBe('spectator');
    expect(late.player.participated).toBe(false);
  } finally {
    room.dispose();
  }
});

test('never keeps a newcomer out of every phase and admits them at the rematch', async () => {
  const { room, host } = await startedRoom({ lateJoin: 'never', selectedHoleIds: ['p'] });
  try {
    const late = enter(room, 'Late');
    expect(late.player.role).toBe('spectator');
    expect(room.roster().find((row) => row.uid === late.identity.uid).spectatorReason).toBe(
      'next-match',
    );
    // They cannot score, however hard they try.
    room.handle(late.ws, { t: 'prog', st: 9 });
    room.handle(late.ws, { f: 1, s: 1, p: 3 });
    expect(late.player.strokes).toBe(0);

    room.handle(host.ws, { f: 1, s: 2, p: 3 });
    await waitForRoom(() => room.phase === 'final');
    expect(room.standings().map((row) => row.name)).toEqual(['Host']);

    // A rematch is a new match, so the policy starts again from the lobby.
    room.handle(host.ws, { t: 'rematch' });
    await delay(5);
    expect(late.player.role).toBe('player');
  } finally {
    room.dispose();
  }
});

test('a newcomer during results waits for the next hole and cannot score the finished one', async () => {
  const { room, host } = await startedRoom({ lateJoin: 'always' });
  try {
    room.handle(host.ws, { f: 1, s: 2, p: 3 });
    await waitForRoom(() => room.phase === 'hole-results');
    const late = enter(room, 'Late');
    // The hole is over: admitting them now would let them claim a score they did
    // not play for, so they wait.
    expect(late.player.role).toBe('spectator');
    expect(room.roster().find((row) => row.uid === late.identity.uid).spectatorReason).toBe(
      'next-hole',
    );
    room.handle(late.ws, { f: 1, s: 1, p: 3 });
    expect(late.player.strokes).toBe(0);

    await waitForRoom(() => room.holeIndex === 1 && room.phase === 'playing');
    expect(late.player.role).toBe('player');
    // The finished hole records only the player who was there for it.
    expect(room.roundHistory[0].rows).toHaveLength(1);
    expect(late.player.totalStrokes).toBe(0);
  } finally {
    room.dispose();
  }
});

test('the last player disconnecting mid-hole preserves the round for a reconnect', async () => {
  // The room must not silently forfeit the hole when its only player drops: they
  // may be coming back, and their score depends on the round still being open.
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5, timerMs: 0 });
  const host = enter(room, 'Host', true);
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p'], elimination: false },
  });
  room.handle(host.ws, { t: 'start' });
  await waitForRoom(() => room.phase === 'playing');
  room.handle(host.ws, { t: 'prog', st: 3 });

  room.close(host.ws);
  // Still playing, still holding the identity and its progress.
  expect(room.phase).toBe('playing');
  expect(host.player.ws).toBe(null);
  expect(host.player.strokes).toBe(3);
  expect(host.player.done).toBe(false);

  // Reconnecting with the same document resumes rather than forfeiting.
  const again = socket();
  room.handle(again, { t: 'join', ...host.identity, instance: host.player.instance, protocol: 2 });
  expect(host.player.ws).toBe(again);
  expect(host.player.role).toBe('player');
  expect(host.player.done).toBe(false);
  room.handle(again, { f: 1, s: 3, p: 3 });
  await waitForRoom(() => room.phase === 'final');
  expect(room.standings()[0].totalStrokes).toBe(3);
  room.dispose();
});
