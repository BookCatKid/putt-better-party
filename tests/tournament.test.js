import { test, expect } from 'bun:test';
import { Room } from '../src/room.js';

/**
 * Tournament mode: a run of matches ranked by accumulated points.
 *
 * The backlog item allows brackets or standings; this is the standings form, because
 * it needs no seeding and composes with the match lifecycle that already exists. The
 * rule is fixed here: points are `competitors - rank + 1`, a competitor who misses a
 * match keeps what they earned, and a finished tournament stays on screen until the
 * host starts the next one.
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
async function waitForRoom(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Room did not reach the expected state');
    }
    await delay(5);
  }
}

/** A one-hole room, optionally with a tournament configured. */
async function lobbyRoom(names, config = {}) {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 0 });
  const host = enter(room, 'Host', true);
  const guests = names.map((name) => enter(room, name));
  room.handle(host.ws, {
    t: 'config',
    config: {
      mapSource: 'picked',
      selectedHoleIds: ['p'],
      elimination: false,
      tournament: true,
      tournamentRounds: 3,
      ...config,
    },
  });
  return { room, host, guests };
}

async function playMatch({ room, host, guests }, strokes) {
  room.handle(host.ws, { t: 'start' });
  await waitForRoom(() => room.phase === 'playing');
  // `strokes` is one entry per player, host first. A null means "do not hole out",
  // which the room charges at the hole's end.
  room.handle(host.ws, { f: 1, s: strokes[0], p: room.specs[0].par });
  guests.forEach((guest, index) => {
    if (strokes[index + 1] !== null) {
      room.handle(guest.ws, { f: 1, s: strokes[index + 1], p: room.specs[0].par });
    }
  });
  if (strokes.some((value) => value === null)) {
    room.endHole();
  }
  await waitForRoom(() => room.phase === 'final');
}

async function rematch({ room, host }) {
  room.handle(host.ws, { t: 'rematch' });
  await waitForRoom(() => room.phase === 'lobby');
}

test('tournament play is off by default and shows no table', async () => {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 0 });
  try {
    expect(room.config.tournament).toBe(false);
    expect(room.config.tournamentRounds).toBe(3);
    const host = enter(room, 'Host', true);
    room.handle(host.ws, {
      t: 'config',
      config: { mapSource: 'picked', selectedHoleIds: ['p'], elimination: false },
    });
    await playMatch({ room, host, guests: [] }, [2]);
    expect(room.snapshot().tournament).toBe(null);
  } finally {
    room.dispose();
  }
});

test('points are competitors minus rank plus one, so the field size decides the reward', async () => {
  const { room, host, guests } = await lobbyRoom(['Second', 'Third']);
  try {
    await playMatch({ room, host, guests }, [2, 3, 4]);
    const table = room.snapshot().tournament;
    expect(table.rounds).toBe(3);
    expect(table.completed).toBe(1);
    expect(table.finished).toBe(false);
    // Three competitors: first earns 3, second 2, last 1.
    expect(table.standings.map((row) => [row.name, row.points, row.wins, row.matches])).toEqual([
      ['Host', 3, 1, 1],
      ['Second', 2, 0, 1],
      ['Third', 1, 0, 1],
    ]);
    expect(table.standings.map((row) => row.rank)).toEqual([1, 2, 3]);
  } finally {
    room.dispose();
  }
});

test('points accumulate across matches and the tournament finishes after its rounds', async () => {
  const { room, host, guests } = await lobbyRoom(['Guest']);
  try {
    // Two competitors, so a win is 2 and a loss is 1.
    await playMatch({ room, host, guests }, [2, 4]);
    await rematch({ room, host });
    await playMatch({ room, host, guests }, [5, 3]);
    expect(room.snapshot().tournament.completed).toBe(2);
    expect(room.snapshot().tournament.finished).toBe(false);

    await rematch({ room, host });
    await playMatch({ room, host, guests }, [2, 4]);
    const table = room.snapshot().tournament;
    expect(table.completed).toBe(3);
    expect(table.finished).toBe(true);
    // Host won twice (2+2), Guest once (1+2); Host also lost once (1).
    expect(table.standings.map((row) => [row.name, row.points, row.wins, row.matches])).toEqual([
      ['Host', 5, 2, 3],
      ['Guest', 4, 1, 3],
    ]);
    // The table survives into the lobby, so the host can see the result before
    // deciding what to do next.
    await rematch({ room, host });
    expect(room.phase).toBe('lobby');
    expect(room.snapshot().tournament.finished).toBe(true);
    expect(room.snapshot().tournament.standings.map((row) => row.name)).toEqual(['Host', 'Guest']);
  } finally {
    room.dispose();
  }
});

test('a competitor who misses a match keeps their points and is not charged', async () => {
  const { room, host, guests } = await lobbyRoom(['Second', 'Third']);
  try {
    await playMatch({ room, host, guests }, [2, 3, 4]);
    // Third leaves; a rematch drops disconnected players from the room.
    room.close(guests[1].ws);
    await rematch({ room, host });
    expect(room.players.has(guests[1].identity.uid)).toBe(false);
    await playMatch({ room, host, guests: [guests[0]] }, [2, 3]);

    const table = room.snapshot().tournament;
    // Third keeps the one point from the match they played. In the second match the
    // field is two, so a win is 2 and second is 1: Host 3+2, Second 2+1, Third 1.
    expect(table.standings.map((row) => [row.name, row.points, row.matches])).toEqual([
      ['Host', 5, 2],
      ['Second', 3, 2],
      ['Third', 1, 1],
    ]);
  } finally {
    room.dispose();
  }
});

test('a finished tournament starts afresh when the host begins the next match', async () => {
  const { room, host, guests } = await lobbyRoom(['Guest'], { tournamentRounds: 2 });
  try {
    await playMatch({ room, host, guests }, [2, 4]);
    await rematch({ room, host });
    await playMatch({ room, host, guests }, [2, 4]);
    expect(room.snapshot().tournament.finished).toBe(true);
    expect(room.snapshot().tournament.standings[0].points).toBe(4);

    await rematch({ room, host });
    // Still visible while the host is in the lobby.
    expect(room.snapshot().tournament.finished).toBe(true);
    room.handle(host.ws, { t: 'start' });
    await waitForRoom(() => room.phase === 'playing');
    // A new run, not a continuation.
    expect(room.snapshot().tournament.completed).toBe(0);
    expect(room.snapshot().tournament.finished).toBe(false);
    expect(room.snapshot().tournament.standings).toEqual([]);
  } finally {
    room.dispose();
  }
});

test('turning the rule off clears the table rather than hiding stale points', async () => {
  const { room, host, guests } = await lobbyRoom(['Guest']);
  try {
    await playMatch({ room, host, guests }, [2, 4]);
    expect(room.snapshot().tournament.completed).toBe(1);
    await rematch({ room, host });
    room.handle(host.ws, { t: 'config', config: { tournament: false } });
    expect(room.config.tournament).toBe(false);
    expect(room.snapshot().tournament).toBe(null);
    expect(room.tournament).toBe(null);
    // And turning it back on starts a new table at the next match.
    room.handle(host.ws, { t: 'config', config: { tournament: true } });
    room.handle(host.ws, { t: 'start' });
    await waitForRoom(() => room.phase === 'playing');
    expect(room.snapshot().tournament.completed).toBe(0);
  } finally {
    room.dispose();
  }
});

test('tournament play composes with team play and ranks the team slots', async () => {
  const { room, host, guests } = await lobbyRoom(['Guest'], { teams: true });
  try {
    await playMatch({ room, host, guests }, [2, 4]);
    const table = room.snapshot().tournament;
    // The final board is two teams, so the tournament ranks the same competitors.
    expect(table.standings.map((row) => [row.name, row.points])).toEqual([
      ['Team 1', 2],
      ['Team 2', 1],
    ]);
    expect(room.snapshot().teams.map((team) => team.name)).toEqual(['Team 1', 'Team 2']);
  } finally {
    room.dispose();
  }
});

test('the checkpoint carries the tournament and an older checkpoint restores without one', async () => {
  const { room, host, guests } = await lobbyRoom(['Guest']);
  try {
    await playMatch({ room, host, guests }, [2, 4]);
    const checkpoint = room.checkpoint();
    expect(checkpoint.tournament.completed).toBe(1);
    expect(checkpoint.tournament.standings[0].name).toBe('Host');

    const restored = new Room('ABCDE', maps);
    restored.restore(checkpoint);
    expect(restored.tournament).toEqual(checkpoint.tournament);
    expect(restored.snapshot().tournament).toEqual(checkpoint.tournament);
    restored.dispose();

    // A row written before tournaments existed loads as an ordinary party.
    delete checkpoint.tournament;
    const older = new Room('ABCDE', maps);
    older.restore(checkpoint);
    expect(older.tournament).toBe(null);
    expect(older.snapshot().tournament).toBe(null);
    older.dispose();
  } finally {
    room.dispose();
  }
});

test('the round count is bounded and validated', async () => {
  const room = new Room('ABCDE', maps);
  try {
    const host = enter(room, 'Host', true);
    for (const tournamentRounds of [1, 21, 3.5, 'three', null]) {
      room.handle(host.ws, { t: 'config', config: { tournamentRounds } });
      expect(room.config.tournamentRounds).toBe(3);
    }
    room.handle(host.ws, { t: 'config', config: { tournamentRounds: 10 } });
    expect(room.config.tournamentRounds).toBe(10);
    room.handle(host.ws, { t: 'config', config: { tournamentRounds: 2 } });
    expect(room.config.tournamentRounds).toBe(2);
  } finally {
    room.dispose();
  }
});
