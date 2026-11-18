import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Room } from '../src/room.js';
import { Leaderboard, eligibleScores } from '../src/leaderboard.js';

const course = { id: 'level', name: 'Hole', par: 3 };
const maps = new Map([
  ['one', { id: 'one', spec: course }],
  ['two', { id: 'two', spec: course }],
]);
function finalized(name, strokes, timeMs, holes = 2) {
  const room = new Room('ABCDE', maps);
  const identity = room.issue(name);
  room.players.set(identity.uid, { ...identity, name, participated: true });
  room.phase = 'final';
  room.config.holes = holes;
  room.roundHistory = Array.from({ length: holes }, (_unused, index) => ({
    index,
    id: 'one',
    title: 'Hole',
    status: 'completed',
    rows: [{ uid: identity.uid, strokes, timeMs, status: 'holed' }],
  }));
  return room;
}
test('all time scores persist, update only when improved, split by hole count, rank by strokes then time and keep global search rank', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bp-ranks-'));
  const file = path.join(directory, 'scores.sqlite');
  let db = new Database(file);
  const board = new Leaderboard(db);
  try {
    board.record(finalized('Simon', 5, 2000));
    board.record(finalized('simon', 6, 1000));
    board.record(finalized('SIMON', 5, 1000));
    board.record(finalized('Alex', 4, 3000));
    board.record(finalized('Zed', 5, 500));
    board.record(finalized('Simon', 2, 1000, 4));
    expect(
      board.list(2, '', 0).rows.map((row) => [row.name, row.strokes, row.timeMs, row.rank]),
    ).toEqual([
      ['Alex', 8, 6000, 1],
      ['Zed', 10, 1000, 2],
      ['SIMON', 10, 2000, 3],
    ]);
    expect(board.list(2, 'simon', 0).rows[0].rank).toBe(3);
    expect(board.list(2, '%', 0).rows).toEqual([]);
    expect(board.list(4, '', 0).rows[0].strokes).toBe(8);
    db.close();
    db = new Database(file);
    expect(new Leaderboard(db).list(2, '', 0).rows).toHaveLength(3);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test('exclude playlists, restarted matches, skipped or ended holes, timeout and late joiners', () => {
  const room = finalized('Player', 2, 100);
  expect(eligibleScores(room)).toHaveLength(1);
  room.config.mapSource = 'picked';
  expect(eligibleScores(room)).toEqual([]);
  room.config.mapSource = 'random';
  room.recordEligible = false;
  expect(eligibleScores(room)).toEqual([]);
  room.recordEligible = true;
  room.roundHistory[0].status = 'skipped';
  expect(eligibleScores(room)).toEqual([]);
  room.roundHistory[0].status = 'ended';
  expect(eligibleScores(room)).toEqual([]);
  room.roundHistory[0].status = 'completed';
  room.roundHistory[0].rows[0].status = 'timeout';
  expect(eligibleScores(room)).toEqual([]);
  room.roundHistory[0].rows = [];
  expect(eligibleScores(room)).toEqual([]);
});
test('real room finalization writes a completed random match once and excludes a host restart', async () => {
  const db = new Database(':memory:');
  const board = new Leaderboard(db);
  const room = new Room('ABCDE', maps, {
    countdown: 1,
    results: 1,
    onFinalize: (finished) => board.record(finished),
  });
  function enter(name, host = false) {
    const identity = room.issue(name);
    const ws = { data: {}, send() {}, close() {} };
    room.handle(ws, {
      t: 'join',
      ...identity,
      protocol: 2,
      host: host ? room.hostToken : undefined,
    });
    return ws;
  }
  async function wait(condition) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) {
        return;
      }
      await Bun.sleep(5);
    }
    throw Error('Round did not advance');
  }
  try {
    const host = enter('Host', true);
    const guest = enter('Guest');
    room.handle(host, { t: 'config', config: { holes: 2, elimination: false } });
    room.handle(host, { t: 'start' });
    for (let index = 0; index < 2; index++) {
      await wait(() => room.phase === 'playing' && room.holeIndex === index);
      room.handle(host, { f: 1, s: 2, p: 3 });
      room.handle(guest, { f: 1, s: 3, p: 3 });
    }
    await wait(() => room.phase === 'final');
    expect(board.list(2, '', 0).rows.map((row) => row.strokes)).toEqual([4, 6]);
    room.handle(host, { t: 'rematch' });
    room.handle(host, { t: 'start' });
    await wait(() => room.phase === 'playing');
    room.handle(host, { t: 'host-action', action: 'restart', matchId: room.matchId, holeIndex: 0 });
    for (let index = 0; index < 2; index++) {
      await wait(() => room.phase === 'playing' && room.holeIndex === index);
      room.handle(host, { f: 1, s: 1, p: 3 });
      room.handle(guest, { f: 1, s: 1, p: 3 });
    }
    await wait(() => room.phase === 'final');
    expect(board.list(2, '', 0).rows.map((row) => row.strokes)).toEqual([4, 6]);
  } finally {
    room.dispose();
    db.close();
  }
});
