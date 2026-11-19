import { test, expect } from 'bun:test';
import { Room } from '../src/room.js';

/**
 * Timeout penalties, and the scorecard's agreement with the totals.
 *
 * The `par + 5` rule is this project's own policy: the original client renders a
 * server-supplied board and never computes a penalty, so there is nothing to copy.
 * These tests pin the rule as it stands rather than changing it - making it
 * configurable is a policy decision that needs approval, not a quiet edit.
 *
 * The invariant that matters most is that the per-hole rows a scorecard renders add
 * up to the total it shows beside them. A penalty applied to one and not the other
 * would make the scorecard contradict itself.
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
async function waitForRoom(condition, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Room did not reach the expected state');
    }
    await delay(5);
  }
}

/** A room in play, with one host and the given guests already joined. */
async function playingRoom(names, config = {}) {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const host = enter(room, 'Host', true);
  const guests = names.map((name) => enter(room, name));
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p'], elimination: false, ...config },
  });
  room.handle(host.ws, { t: 'start' });
  await delay(12);
  room.handle(host.ws, { t: 'scene', matchId: room.matchId, holeIndex: 0, levelId: 'p' });
  await waitForRoom(() => room.phase === 'playing');
  return { room, host, guests };
}

/**
 * The sum of what each recorded hole says a player scored.
 *
 * Mirrors the scorecard: `round.rows` supplies the per-hole cell and
 * `standings.totalStrokes` supplies the total beside it.
 */
function rowsTotal(room, uid) {
  return room.roundHistory.reduce((total, round) => {
    const row = round.rows.find((entry) => entry.uid === uid);
    return total + (typeof row?.strokes === 'number' ? row.strokes : 0);
  }, 0);
}

test('par + 5 is a minimum, not an addition', async () => {
  const { room, guests } = await playingRoom(['Under', 'Over']);
  const par = room.specs[0].par;
  // One player took fewer strokes than the penalty, one took more.
  Object.assign(guests[0].player, { strokes: 1 });
  Object.assign(guests[1].player, { strokes: par + 9 });
  room.endHole();

  const rows = room.roundHistory.at(-1).rows;
  const under = rows.find((row) => row.uid === guests[0].identity.uid);
  const over = rows.find((row) => row.uid === guests[1].identity.uid);
  expect(under).toMatchObject({ status: 'timeout', strokes: par + 5 });
  // A player who had already exceeded the penalty keeps their real score: the rule
  // charges the worse of the two, never adds a penalty on top of a bad hole.
  expect(over).toMatchObject({ status: 'timeout', strokes: par + 9 });
  room.dispose();
});

test('two players who both time out are charged the same and ranked by name', async () => {
  const { room, guests } = await playingRoom(['Bravo', 'Alpha']);
  const par = room.specs[0].par;
  for (const guest of guests) {
    Object.assign(guest.player, { strokes: 0 });
  }
  room.endHole();

  for (const guest of guests) {
    expect(guest.player.totalStrokes).toBe(par + 5);
    expect(guest.player.holesSurvived).toBe(1);
  }
  // Equal scorecards still get distinct ranks, decided by name, because the pinned
  // client indexes one medal per rank.
  const rows = room.standings();
  expect(rows.map((row) => row.name)).toEqual(['Alpha', 'Bravo', 'Host']);
  expect(rows.map((row) => row.rank)).toEqual([1, 2, 3]);
  room.dispose();
});

test('elimination removes a non-finisher instead of charging them', async () => {
  const { room, guests } = await playingRoom(['Out'], { elimination: true });
  const guest = guests[0];
  Object.assign(guest.player, { strokes: 4, totalStrokes: 0, holesSurvived: 0 });
  room.endHole();

  const row = room.roundHistory.at(-1).rows.find((entry) => entry.uid === guest.identity.uid);
  // A null score is what the scorecard renders as DNF.
  expect(row).toMatchObject({ status: 'eliminated', strokes: null });
  expect(guest.player.alive).toBe(false);
  expect(guest.player.role).toBe('spectator');
  expect(guest.player.totalStrokes).toBe(0);
  expect(guest.player.holesSurvived).toBe(0);
  room.dispose();
});

test('the scorecard rows add up to the total beside them', async () => {
  // Three holes: a hole out, a timeout, and a forfeit. Every recorded row must
  // reconcile with `standings.totalStrokes`, which is what the scorecard shows.
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const host = enter(room, 'Host', true);
  const guest = enter(room, 'Guest');
  room.handle(host.ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p', 'q', 'p'], elimination: false },
  });
  room.handle(host.ws, { t: 'start' });
  await delay(12);
  room.handle(host.ws, { t: 'scene', matchId: room.matchId, holeIndex: 0, levelId: 'p' });
  await waitForRoom(() => room.phase === 'playing');

  // Hole 1: the host holes out, the guest times out.
  room.handle(host.ws, { f: 1, s: 2, p: 3 });
  room.endHole();
  await waitForRoom(() => room.phase === 'playing' && room.holeIndex === 1);

  // Hole 2: the host forfeits, the guest holes out.
  room.handle(host.ws, { t: 'forfeit' });
  room.handle(guest.ws, { f: 1, s: 1, p: 2 });
  room.endHole();
  await waitForRoom(() => room.phase === 'playing' && room.holeIndex === 2);

  // Hole 3: both time out.
  room.endHole();
  await delay(5);

  for (const player of [host.player, guest.player]) {
    expect(rowsTotal(room, player.uid)).toBe(player.totalStrokes);
  }
  // And the totals are not accidentally all equal, which would let a broken sum
  // pass: the host has 2 + (par 2 + 5) + (par 3 + 5).
  expect(host.player.totalStrokes).toBe(2 + 7 + 8);
  expect(guest.player.totalStrokes).toBe(8 + 1 + 8);
  room.dispose();
});

test('the penalty is fixed policy, not a settable configuration', async () => {
  // The item's condition: making it configurable needs policy approval, so the
  // config surface must not already accept it. A key the server ignores would be
  // worse than no key, because it would look like it worked.
  const room = new Room('ABCDE', maps);
  const host = enter(room, 'Host', true);
  room.handle(host.ws, {
    t: 'config',
    config: { timeoutPenalty: 99, parPenalty: 1, penalty: 0 },
  });
  expect('timeoutPenalty' in room.config).toBe(false);
  expect('parPenalty' in room.config).toBe(false);
  expect('penalty' in room.config).toBe(false);
  room.dispose();
});
