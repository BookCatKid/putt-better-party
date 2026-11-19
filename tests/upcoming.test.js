import { test, expect } from 'bun:test';
import { Room } from '../src/room.js';

/**
 * What the upcoming display is allowed to read.
 *
 * The line is a view of `holeIds[holeIndex + 1]`, `playlistTitles`, `preparing` and
 * `nextError`. These tests pin those four fields through a real next-course load, a
 * failure and a retry, because the display can only be as accurate as they are.
 *
 * The room prefetches the next course while the current one is played, so the first
 * `loadMap` call is speculative and silent. The boundary load is the one that reports,
 * and it is the one these tests drive.
 */

const spec = { id: 'public-level', name: 'Example', par: 3 };
const maps = new Map([
  ['p', { id: 'p', title: 'Example', spec }],
  [
    'q',
    {
      id: 'q',
      title: 'The next one',
      spec: { ...spec, id: 'next', name: 'The next one', par: 2 },
    },
  ],
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

/** A two-hole room whose boundary load is a promise the test controls. */
async function roomAtNextLoad() {
  const attempts = [];
  const room = new Room('ABCDE', maps, {
    countdown: 5,
    results: 0,
    prepareMatch: async (connection) => ({
      ids: connection.selectedHoleIds,
      specs: [maps.get('p').spec],
    }),
    loadMap: (id) =>
      new Promise((resolve, reject) => {
        attempts.push({ id, resolve, reject });
      }),
  });
  const host = enter(room, 'Host', true);
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q'], elimination: false },
  });
  room.handle(host.ws, { t: 'start' });
  await waitForRoom(() => room.phase === 'playing');

  // Hole out so the room advances and starts its boundary load. `loadingNext` is what
  // distinguishes that load from the silent prefetch, which never reports.
  const before = attempts.length;
  room.handle(host.ws, { f: 1, s: 2, p: 3 });
  await waitForRoom(() => room.loadingNext === true && attempts.length > before);
  return { room, host, attempts, boundary: attempts.at(-1) };
}

test('the snapshot names the next course while it is loading', async () => {
  const { room, boundary } = await roomAtNextLoad();
  try {
    const snapshot = room.snapshot();
    // The display looks the next course up by this index, so it must be the second id.
    expect(snapshot.holeIndex).toBe(0);
    expect(snapshot.holeIds[snapshot.holeIndex + 1]).toBe('q');
    expect(snapshot.playlistTitles.q).toBe('The next one');
    // Loading is reported, and the old failure field is clear.
    expect(snapshot.preparing).toBe(true);
    expect(snapshot.nextError).toBe(null);
    expect(boundary.id).toBe('q');

    boundary.resolve(maps.get('q'));
    await waitForRoom(() => room.phase === 'playing' && room.holeIndex === 1);
    expect(room.snapshot().preparing).toBe(false);
    expect(room.snapshot().nextError).toBe(null);
  } finally {
    room.dispose();
  }
});

test('a failed next load is reported, and a retry stops reporting the old failure', async () => {
  const { room, host, attempts, boundary } = await roomAtNextLoad();
  try {
    boundary.reject(new Error('upstream unavailable'));
    await waitForRoom(() => room.snapshot().nextError !== null);
    const failed = room.snapshot();
    expect(failed.preparing).toBe(false);
    expect(failed.nextError).toContain('Could not load the next public hole');
    // The next course is still the one that failed; the display must not forget it.
    expect(failed.holeIds[failed.holeIndex + 1]).toBe('q');

    // Retry: the attempt is loading again, so the failure is no longer the state.
    // This is the bug the display exposed - the error stayed set through the retry.
    const beforeRetry = attempts.length;
    room.handle(host.ws, {
      t: 'host-action',
      action: 'retry-next',
      requestId: 'retry-1',
      matchId: room.matchId,
      holeIndex: room.holeIndex,
    });
    await waitForRoom(() => attempts.length > beforeRetry && room.loadingNext === true);
    const retrying = room.snapshot();
    expect(retrying.preparing).toBe(true);
    expect(retrying.nextError).toBe(null);

    // A second failure is reported again rather than swallowed.
    attempts.at(-1).reject(new Error('still unavailable'));
    await waitForRoom(() => room.snapshot().nextError !== null);
    expect(room.snapshot().nextError).toContain('Could not load the next public hole');
  } finally {
    room.dispose();
  }
});

test('the last hole has no next course to show', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 0 });
  const host = enter(room, 'Host', true);
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p'], elimination: false },
  });
  room.handle(host.ws, { t: 'start' });
  await waitForRoom(() => room.phase === 'playing');
  const snapshot = room.snapshot();
  // Undefined is what makes the display return null rather than "Next: hole 2".
  expect(snapshot.holeIds[snapshot.holeIndex + 1]).toBeUndefined();
  room.dispose();
});
