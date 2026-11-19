import { test, expect } from 'bun:test';
import { Room } from '../src/room.js';

/**
 * Completed-match history.
 *
 * A match summary is kept through a rematch and a restart, bounded, and free of
 * anything playable or secret. These tests pin the summary the client renders and the
 * checkpoint the process reloads.
 */

const spec = { id: 'public-level', name: 'Example', par: 3 };
const maps = new Map([['p', { id: 'p', title: 'Example course', spec }]]);
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

/** A one-hole match finished by both players, so the room reaches `final`. */
async function finishedMatch() {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 0 });
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p'], elimination: false },
  });
  room.handle(host.ws, { t: 'start' });
  await waitForRoom(() => room.phase === 'playing');
  room.handle(host.ws, { f: 1, s: 2, p: 3 });
  room.handle(guest.ws, { f: 1, s: 3, p: 3 });
  await waitForRoom(() => room.phase === 'final');
  return { room, host, guest };
}

test('a finished match is summarised with its courses, pars and standings', async () => {
  const { room } = await finishedMatch();
  try {
    expect(room.matchHistory).toHaveLength(1);
    const summary = room.matchHistory[0];
    expect(summary.matchId).toBe(room.matchId);
    expect(summary.holes).toBe(1);
    expect(typeof summary.endedAt).toBe('number');
    expect(summary.courses).toEqual([{ id: 'p', title: 'Example course', par: 3 }]);
    expect(summary.standings).toEqual([
      { name: 'Host', rank: 1, holesSurvived: 1, totalStrokes: 2, totalTimeMs: expect.any(Number) },
      {
        name: 'Guest',
        rank: 2,
        holesSurvived: 1,
        totalStrokes: 3,
        totalTimeMs: expect.any(Number),
      },
    ]);
    // The snapshot carries the same history, so the client can render it.
    expect(room.snapshot().matchHistory).toEqual(room.matchHistory);

    // A repeated finalize for the same match must not append a duplicate.
    room.finalize();
    expect(room.matchHistory).toHaveLength(1);
  } finally {
    room.dispose();
  }
});

test('a rematch keeps the history and clears only the current match', async () => {
  const { room, host } = await finishedMatch();
  try {
    room.handle(host.ws, { t: 'rematch' });
    await delay(5);
    expect(room.phase).toBe('lobby');
    expect(room.roundHistory).toEqual([]);
    // The completed match is still there, with its scores intact.
    expect(room.matchHistory).toHaveLength(1);
    expect(room.matchHistory[0].standings.map((row) => row.name)).toEqual(['Host', 'Guest']);
    expect(room.snapshot().matchHistory).toHaveLength(1);
  } finally {
    room.dispose();
  }
});

test('the checkpoint carries the history and nothing playable or secret', async () => {
  const { room } = await finishedMatch();
  try {
    const checkpoint = room.checkpoint();
    expect(checkpoint.matchHistory).toHaveLength(1);
    const summary = checkpoint.matchHistory[0];
    // Exact key sets: a course is id/title/par, a row is the score, and neither has
    // grown a specification, a session, a token or a uid.
    for (const course of summary.courses) {
      expect(Object.keys(course).sort()).toEqual(['id', 'par', 'title']);
    }
    for (const row of summary.standings) {
      expect(Object.keys(row).sort()).toEqual([
        'holesSurvived',
        'name',
        'rank',
        'totalStrokes',
        'totalTimeMs',
      ]);
    }
    const historyJson = JSON.stringify(summary);
    expect(historyJson).not.toContain('spec');
    expect(historyJson).not.toContain('session');
    expect(historyJson).not.toContain('token');
    expect(historyJson).not.toContain('uid');
    // The rest of the checkpoint is unchanged by this feature: the existing room
    // fields are still there, so the history is additive rather than a replacement.
    expect(checkpoint.code).toBe('ABCDE');
    expect(checkpoint.config.selectedHoleIds).toEqual(['p']);
  } finally {
    room.dispose();
  }
});

test('a restored room has the history that was checkpointed', async () => {
  const { room } = await finishedMatch();
  const checkpoint = room.checkpoint();
  room.dispose();
  const restored = new Room('ABCDE', maps);
  try {
    restored.restore(checkpoint);
    expect(restored.matchHistory).toEqual(checkpoint.matchHistory);
    expect(restored.snapshot().matchHistory).toEqual(checkpoint.matchHistory);
  } finally {
    restored.dispose();
  }
});

test('history is bounded and keeps the newest matches', () => {
  const room = new Room('ABCDE', maps);
  try {
    for (let index = 0; index < 12; index += 1) {
      room.matchId = 'match-' + index;
      room.finalize();
    }
    expect(room.matchHistory).toHaveLength(10);
    expect(room.matchHistory[0].matchId).toBe('match-11');
    expect(room.matchHistory.at(-1).matchId).toBe('match-2');
  } finally {
    room.dispose();
  }
});
