import { test, expect } from 'bun:test';
import { Room } from '../src/room.js';

/**
 * Team play.
 *
 * An optional, independent rule: when it is off nothing changes, and when it is on the
 * party is scored by team without changing how a hole is played. The design is fixed
 * here because the pinned client only renders what the server sends - two teams,
 * alternating assignment in join order, and a team score that is the sum of what its
 * members actually scored.
 */

const spec = { id: 'public-level', name: 'Example', par: 3 };
const maps = new Map([
  ['p', { id: 'p', title: 'First', spec }],
  ['q', { id: 'q', title: 'Second', spec: { ...spec, id: 'next', par: 2 } }],
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
async function waitForRoom(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Room did not reach the expected state');
    }
    await delay(5);
  }
}

/** A started room with the given names, one hole, no results pause. */
async function startedRoom(names, config = {}) {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 0 });
  const host = enter(room, 'Host', true);
  const guests = names.map((name) => enter(room, name));
  room.handle(host.ws, {
    t: 'config',
    config: {
      mapSource: 'picked',
      selectedHoleIds: ['p'],
      elimination: false,
      teams: true,
      ...config,
    },
  });
  room.handle(host.ws, { t: 'start' });
  await waitForRoom(() => room.phase === 'playing');
  return { room, host, guests };
}

const teamOf = (room, name) => room.teams().find((team) => team.name === name);

test('team play is off by default and changes nothing when it is', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 0 });
  try {
    expect(room.config.teams).toBe(false);
    const host = enter(room, 'Host', true);
    room.handle(host.ws, {
      t: 'config',
      config: { mapSource: 'picked', selectedHoleIds: ['p'], elimination: false },
    });
    room.handle(host.ws, { t: 'start' });
    await waitForRoom(() => room.phase === 'playing');
    // No teams are formed and no player carries a team.
    expect(room.snapshot().teams).toEqual([]);
    expect(host.player.team).toBeUndefined();
    room.handle(host.ws, { f: 1, s: 2, p: 3 });
    await waitForRoom(() => room.phase === 'final');
    // The standings are players, exactly as before the feature existed.
    expect(room.standings().map((row) => row.name)).toEqual(['Host']);
  } finally {
    room.dispose();
  }
});

test('two teams are formed by alternating join order', async () => {
  const { room } = await startedRoom(['Second', 'Third', 'Fourth']);
  try {
    const teams = room.teams();
    expect(teams.map((team) => team.name)).toEqual(['Team 1', 'Team 2']);
    expect(teams.map((team) => team.id)).toEqual(['team-1', 'team-2']);
    // Join order is Host, Second, Third, Fourth.
    expect(teams[0].members.map((uid) => room.players.get(uid).name)).toEqual(['Host', 'Third']);
    expect(teams[1].members.map((uid) => room.players.get(uid).name)).toEqual(['Second', 'Fourth']);
    // The snapshot carries the same assignment, which is what the client groups by.
    expect(room.snapshot().teams).toEqual(teams);
  } finally {
    room.dispose();
  }
});

test('a team score is the sum of its members, ranked against the other team', async () => {
  // Two players, so one per team: the totals are directly comparable.
  const { room, host, guests } = await startedRoom(['Guest']);
  try {
    room.handle(host.ws, { f: 1, s: 2, p: 3 });
    room.handle(guests[0].ws, { f: 1, s: 4, p: 3 });
    await waitForRoom(() => room.phase === 'final');

    const standings = room.standings();
    expect(standings.map((row) => row.name)).toEqual(['Team 1', 'Team 2']);
    expect(standings.map((row) => row.uid)).toEqual(['team-1', 'team-2']);
    expect(standings.map((row) => row.totalStrokes)).toEqual([2, 4]);
    // Dense ranks, because the client indexes one medal per rank.
    expect(standings.map((row) => row.rank)).toEqual([1, 2]);
    // The per-player rows are unchanged: team play changes the scoreboard, not scoring.
    expect(room.roundHistory[0].rows).toEqual([
      { uid: host.identity.uid, strokes: 2, status: 'holed', timeMs: expect.any(Number) },
      { uid: guests[0].identity.uid, strokes: 4, status: 'holed', timeMs: expect.any(Number) },
    ]);
  } finally {
    room.dispose();
  }
});

test('two players on one team add up on the same hole', async () => {
  // Three players: Team 1 is Host and Third, Team 2 is Second alone.
  const { room, host, guests } = await startedRoom(['Second', 'Third']);
  try {
    room.handle(host.ws, { f: 1, s: 2, p: 3 });
    room.handle(guests[1].ws, { f: 1, s: 3, p: 3 });
    room.handle(guests[0].ws, { f: 1, s: 5, p: 3 });
    await waitForRoom(() => room.phase === 'final');

    const standings = room.standings();
    // Equal totals are ordered by time and then name, so this asserts the sums by
    // team rather than an order that depends on how long each team took.
    const totals = Object.fromEntries(standings.map((row) => [row.name, row.totalStrokes]));
    expect(totals).toEqual({ 'Team 1': 5, 'Team 2': 5 });
    // Whatever the tiebreak decides, the ranks stay dense.
    expect(standings.map((row) => row.rank)).toEqual([1, 2]);
    // The team's survived holes are the furthest any member reached.
    expect(standings[0].holesSurvived).toBe(1);
  } finally {
    room.dispose();
  }
});

test('a wiped team is eliminated and the match ends when one team is left', async () => {
  // Two holes, so the match could otherwise continue: it must end after the first
  // because Team 2 has nobody left alive.
  const { room, host, guests } = await startedRoom(['Out'], {
    elimination: true,
    selectedHoleIds: ['p', 'q'],
  });
  try {
    room.handle(host.ws, { f: 1, s: 2, p: 3 });
    // The guest never holes out, so elimination removes them.
    room.endHole();
    await waitForRoom(() => room.phase === 'final');

    const standings = room.standings();
    expect(standings.map((row) => [row.name, row.alive, row.totalStrokes])).toEqual([
      ['Team 1', true, 2],
      ['Team 2', false, 0],
    ]);
    expect(standings[0].holesSurvived).toBe(1);
    // A team that never scored has no survived holes rather than a charged penalty.
    expect(standings[1].holesSurvived).toBe(0);
    expect(room.roundHistory).toHaveLength(1);
    expect(guests[0].player.alive).toBe(false);
  } finally {
    room.dispose();
  }
});

test('a late joiner is balanced onto the smaller team', async () => {
  const { room } = await startedRoom(['Second', 'Third']);
  try {
    // Team 1 has Host and Third, Team 2 has Second.
    expect(teamOf(room, 'Team 1').members).toHaveLength(2);
    expect(teamOf(room, 'Team 2').members).toHaveLength(1);
    const late = enter(room, 'Late');
    // Admitted mid-hole because the default policy is `always`.
    expect(late.player.role).toBe('player');
    expect(late.player.team).toBe(1);
    expect(teamOf(room, 'Team 2').members).toContain(late.identity.uid);
    // And the sides are now even.
    expect(teamOf(room, 'Team 1').members).toHaveLength(2);
    expect(teamOf(room, 'Team 2').members).toHaveLength(2);
  } finally {
    room.dispose();
  }
});

test('a disconnect keeps the team score and only marks the team away when all are gone', async () => {
  const { room, host, guests } = await startedRoom(['Second', 'Third']);
  try {
    room.handle(host.ws, { f: 1, s: 2, p: 3 });
    room.handle(guests[0].ws, { f: 1, s: 4, p: 3 });
    // Third is on Team 1 with the host and has not holed yet; disconnect them.
    room.close(guests[1].ws);
    room.endHole();
    await waitForRoom(() => room.phase === 'final');

    const standings = room.standings();
    const teamOne = standings.find((row) => row.name === 'Team 1');
    const teamTwo = standings.find((row) => row.name === 'Team 2');
    // The dropped player was charged in stroke play, and their score still counts.
    expect(teamOne.totalStrokes).toBe(2 + (room.specs[0].par + 5));
    // Team 1 still has a connected member, so the team is not shown as away.
    expect(teamOne.connected).toBe(true);
    expect(teamTwo.totalStrokes).toBe(4);
    expect(teamTwo.connected).toBe(true);
  } finally {
    room.dispose();
  }
});

test('a team whose members are all disconnected is marked away, not removed', async () => {
  const { room, guests } = await startedRoom(['Second']);
  try {
    room.close(guests[0].ws);
    room.endHole();
    await waitForRoom(() => room.phase === 'final');
    const teamTwo = room.standings().find((row) => row.name === 'Team 2');
    // Still ranked, with its score intact; only the connection flag changed.
    expect(teamTwo).toBeDefined();
    expect(teamTwo.connected).toBe(false);
    expect(teamTwo.totalStrokes).toBe(room.specs[0].par + 5);
  } finally {
    room.dispose();
  }
});

test('a team stays connected while any member is, even if the first one is away', async () => {
  // Team 1 is Host then Third. Dropping the host makes the first member away while a
  // later member is still here, which a first-member check would report wrongly.
  const { room, host } = await startedRoom(['Second', 'Third']);
  try {
    room.close(host.ws);
    room.endHole();
    await waitForRoom(() => room.phase === 'final');
    const teamOne = room.standings().find((row) => row.name === 'Team 1');
    expect(teamOne.connected).toBe(true);
  } finally {
    room.dispose();
  }
});

test('team play is validated as a boolean and restored with a backward-compatible default', async () => {
  const room = new Room('ABCDE', maps);
  try {
    const host = enter(room, 'Host', true);
    room.handle(host.ws, { t: 'config', config: { teams: 'yes' } });
    expect(room.config.teams).toBe(false);
    room.handle(host.ws, { t: 'config', config: { teams: true } });
    expect(room.config.teams).toBe(true);
    const checkpoint = room.checkpoint();
    expect(checkpoint.config.teams).toBe(true);
    // A checkpoint written before team play existed loads as an ordinary party.
    delete checkpoint.config.teams;
    const restored = new Room('ABCDE', maps);
    restored.restore(checkpoint);
    expect(restored.config.teams).toBe(false);
    restored.dispose();
  } finally {
    room.dispose();
  }
});

test('a rematch re-forms teams and turning the rule off removes them', async () => {
  const { room, host } = await startedRoom(['Second']);
  try {
    room.handle(host.ws, { f: 1, s: 2, p: 3 });
    room.handle(room.players.get(room.teams()[1].members[0]).ws, { f: 1, s: 3, p: 3 });
    await waitForRoom(() => room.phase === 'final');
    room.handle(host.ws, { t: 'rematch' });
    await delay(5);
    // Back in the lobby, no team is assigned until the next match starts.
    expect(room.snapshot().teams).toEqual([]);
    expect(host.player.team).toBeUndefined();
    // Switching the rule off leaves the party scored as individuals.
    room.handle(host.ws, { t: 'config', config: { teams: false } });
    expect(room.config.teams).toBe(false);
    expect(room.snapshot().teams).toEqual([]);
  } finally {
    room.dispose();
  }
});
