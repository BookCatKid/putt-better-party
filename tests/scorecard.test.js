import { test, expect } from 'bun:test';
import { Room } from '../src/room.js';

/**
 * What the scorecard is allowed to show.
 *
 * The table is a view of two server structures: `roundHistory` (one record per hole,
 * with one row per player) and `final.standings` (the order and the totals). These
 * tests drive the server through every recorded status and pin those structures, so
 * the renderer is never asked to invent a value. The browser test then checks the
 * table against this data.
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

async function playingRoom({ names = [], config = {} } = {}) {
  // No results delay: these tests assert the recorded data, not the pause between
  // holes, and a zero delay makes the transition to `final` immediate.
  const room = new Room('ABCDE', maps, { countdown: 5, results: 0 });
  const host = enter(room, 'Host', true);
  const guests = names.map((name) => enter(room, name));
  room.handle(host.ws, {
    t: 'config',
    config: {
      mapSource: 'picked',
      selectedHoleIds: ['p'],
      elimination: false,
      ...config,
    },
  });
  room.handle(host.ws, { t: 'start' });
  await waitForRoom(() => room.phase === 'playing');
  return { room, host, guests };
}

const action = (host, room, name, extra = {}) =>
  room.handle(host.ws, {
    t: 'host-action',
    action: name,
    requestId: name,
    matchId: room.matchId,
    holeIndex: room.holeIndex,
    ...extra,
  });

test('a hole-out records the strokes, the course par and a time', async () => {
  const { room, host } = await playingRoom();
  try {
    room.handle(host.ws, { f: 1, s: 2, p: 3 });
    await waitForRoom(() => room.phase === 'final');

    const round = room.roundHistory[0];
    expect(round).toMatchObject({
      index: 0,
      id: 'p',
      title: 'Example',
      par: 3,
      status: 'completed',
    });
    expect(round.rows).toHaveLength(1);
    expect(round.rows[0]).toMatchObject({ uid: host.identity.uid, strokes: 2, status: 'holed' });
    expect(typeof round.rows[0].timeMs).toBe('number');
    expect(round.rows[0].timeMs).toBeGreaterThanOrEqual(0);
    // The total is the sum of what the rows say.
    expect(room.standings()[0].totalStrokes).toBe(2);
  } finally {
    room.dispose();
  }
});

test('a timeout and a forfeit are both scored at par + 5 in stroke play', async () => {
  const { room, host, guests } = await playingRoom({ names: ['Quitter', 'Slow'] });
  try {
    // A forfeit is an action; in stroke play it becomes a timeout at the hole's end,
    // so the scorecard shows a score rather than a DNF.
    action(host, room, 'forfeit-player', { uid: guests[0].identity.uid });
    expect(guests[0].player.done).toBe(true);
    room.endHole();

    const rows = room.roundHistory[0].rows;
    const quitter = rows.find((row) => row.uid === guests[0].identity.uid);
    const slow = rows.find((row) => row.uid === guests[1].identity.uid);
    expect(quitter).toMatchObject({ status: 'timeout', strokes: room.specs[0].par + 5 });
    expect(slow).toMatchObject({ status: 'timeout', strokes: room.specs[0].par + 5 });
    for (const row of [quitter, slow]) {
      expect(typeof row.timeMs).toBe('number');
    }
    // Both were charged, so both totals moved by the same amount.
    expect(guests[0].player.totalStrokes).toBe(room.specs[0].par + 5);
    expect(guests[1].player.totalStrokes).toBe(room.specs[0].par + 5);
  } finally {
    room.dispose();
  }
});

test('elimination records a DNF with no score and no charge', async () => {
  const { room, guests } = await playingRoom({
    names: ['Out'],
    config: { elimination: true },
  });
  try {
    Object.assign(guests[0].player, { strokes: 4, totalStrokes: 0, holesSurvived: 0 });
    room.endHole();

    const row = room.roundHistory[0].rows.find((entry) => entry.uid === guests[0].identity.uid);
    expect(row).toMatchObject({ status: 'eliminated', strokes: null });
    expect(guests[0].player.alive).toBe(false);
    expect(guests[0].player.totalStrokes).toBe(0);
    expect(guests[0].player.holesSurvived).toBe(0);
  } finally {
    room.dispose();
  }
});

test('a skipped hole records no rows and is not charged to anybody', async () => {
  const { room, host, guests } = await playingRoom({ names: ['Guest'] });
  try {
    action(host, room, 'skip');
    const round = room.roundHistory[0];
    expect(round.status).toBe('skipped');
    expect(round.rows).toEqual([]);
    // The par is still recorded; the scorecard chooses to show a dash for a skipped
    // hole, but the server keeps the real value.
    expect(round.par).toBe(3);
    expect(guests[0].player.totalStrokes).toBe(0);
  } finally {
    room.dispose();
  }
});

test('an ended party marks players who had not holed without charging them', async () => {
  const { room, host, guests } = await playingRoom({ names: ['Guest'] });
  try {
    action(host, room, 'end');
    expect(room.phase).toBe('final');
    const round = room.roundHistory[0];
    expect(round.status).toBe('ended');
    for (const uid of [host.identity.uid, guests[0].identity.uid]) {
      const row = round.rows.find((entry) => entry.uid === uid);
      expect(row).toMatchObject({ status: 'ended', strokes: null });
    }
    expect(guests[0].player.totalStrokes).toBe(0);
  } finally {
    room.dispose();
  }
});

test('the final board agrees with the recorded rounds, including a disconnected player', async () => {
  const { room, host, guests } = await playingRoom({ names: ['Gone'] });
  try {
    room.handle(host.ws, { f: 1, s: 2, p: 3 });
    // The guest drops before the hole ends; the round is still open, so they are
    // charged at the boundary and appear on the final board as disconnected.
    room.close(guests[0].ws);
    room.endHole();
    await waitForRoom(() => room.phase === 'final');

    const standings = room.standings();
    expect(room.snapshot().phase).toBe('final');
    // Order: the hole-out beats the timeout.
    expect(standings.map((row) => row.name)).toEqual(['Host', 'Gone']);
    expect(standings[1].connected).toBe(false);
    expect(standings[1].totalStrokes).toBe(room.specs[0].par + 5);

    // Every total equals the sum of that player's recorded rows.
    for (const row of standings) {
      const summed = room.roundHistory.reduce((total, round) => {
        const score = round.rows.find((entry) => entry.uid === row.uid);
        return total + (typeof score?.strokes === 'number' ? score.strokes : 0);
      }, 0);
      expect(row.totalStrokes).toBe(summed);
    }
  } finally {
    room.dispose();
  }
});
