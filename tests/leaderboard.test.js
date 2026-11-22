import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Room } from '../src/room.js';
import { Leaderboard, eligibleScores } from '../src/leaderboard.js';
import { ReplayArchive, newReplayId } from '../src/replays.js';
import { leaderboardPage } from '../src/http-routes.js';

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
  room.config.courseVoting = true;
  expect(eligibleScores(room)).toEqual([]);
  room.config.courseVoting = false;
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
test('a best score records the match it came from and the link survives only while the archive holds that replay', () => {
  const db = new Database(':memory:');
  const board = new Leaderboard(db);
  try {
    const withReplay = finalized('Simon', 5, 2000);
    withReplay.replayId = 'a'.repeat(32);
    withReplay.replayAvailable = true;
    board.record(withReplay);
    expect(board.list(2, '', 0).rows[0].replayId).toBe('a'.repeat(32));
    // A match whose replay was never written must not claim one, so the page cannot
    // offer a link to a recording that does not exist.
    const withoutReplay = finalized('Alex', 4, 1000);
    withoutReplay.replayId = 'b'.repeat(32);
    withoutReplay.replayAvailable = false;
    board.record(withoutReplay);
    expect(board.list(2, '', 0).rows.find((row) => row.name === 'Alex').replayId).toBeNull();
    // Improving the same score replaces the link along with the score, because the
    // newer match is the one that now documents the record.
    const improved = finalized('Simon', 4, 1500);
    improved.replayId = 'c'.repeat(32);
    improved.replayAvailable = true;
    board.record(improved);
    const simon = board.list(2, '', 0).rows.find((row) => row.name === 'Simon');
    expect(simon.strokes).toBe(8);
    expect(simon.replayId).toBe('c'.repeat(32));
    // A worse run does not overwrite the record, and must not overwrite its link.
    const worse = finalized('Simon', 6, 100);
    worse.replayId = 'd'.repeat(32);
    worse.replayAvailable = true;
    board.record(worse);
    expect(board.list(2, '', 0).rows.find((row) => row.name === 'Simon').replayId).toBe(
      'c'.repeat(32),
    );
  } finally {
    db.close();
  }
});
test('a leaderboard row advertises its replay only while the archive still holds it', () => {
  const db = new Database(':memory:');
  try {
    const board = new Leaderboard(db);
    const archive = new ReplayArchive(db);
    const kept = newReplayId();
    const gone = newReplayId();
    const round = (index) => ({
      index,
      title: 'Hole',
      status: 'completed',
      level: course,
      durationMs: 100,
      tracks: [
        {
          id: 1,
          name: 'Player',
          hue: 10,
          status: 'holed',
          strokes: 1,
          timeMs: 100,
          truncated: false,
          samples: [0, 100, 10, 200, 1],
        },
      ],
    });
    expect(archive.record(gone, round(0))).toBe(true);
    expect(archive.record(kept, round(0))).toBe(true);
    // Make `gone` the older match, then prune one byte under the total so the real
    // eviction path drops it. This is the state a ranked score can be left in.
    const age = db.query('UPDATE replay_matches SET created = ? WHERE id = ?');
    age.run(Date.now() - 365 * 86400000, gone);
    age.run(Date.now(), kept);
    const size = db
      .query('SELECT COALESCE(SUM(length(payload)+length(summary)),0) AS size FROM replay_rounds')
      .get().size;
    archive.prune(size - 1);
    expect(archive.retained([gone, kept])).toEqual(new Set([kept]));
    const keptRoom = finalized('Kept', 3, 1000);
    keptRoom.replayId = kept;
    keptRoom.replayAvailable = true;
    board.record(keptRoom);
    const goneRoom = finalized('Gone', 4, 1000);
    goneRoom.replayId = gone;
    goneRoom.replayAvailable = true;
    board.record(goneRoom);
    const page = leaderboardPage(board, archive, 2, '', 0);
    expect(page.rows.map((row) => [row.name, row.replayId])).toEqual([
      ['Kept', kept],
      ['Gone', null],
    ]);
    // The score itself is never hidden just because its recording is gone.
    expect(page.rows.map((row) => row.strokes)).toEqual([6, 8]);
  } finally {
    db.close();
  }
});

test('a database written before the replay column existed is upgraded in place and keeps its scores', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bp-migrate-'));
  const file = path.join(directory, 'scores.sqlite');
  // The exact shape the previous build created, with a row already ranked in it.
  const legacy = new Database(file);
  try {
    legacy.exec(`CREATE TABLE party_best_scores (
      name_key TEXT NOT NULL, name TEXT NOT NULL, holes INTEGER NOT NULL,
      strokes INTEGER NOT NULL, timeMs INTEGER NOT NULL, achievedAt INTEGER NOT NULL,
      PRIMARY KEY (name_key, holes)
    );`);
    legacy
      .query('INSERT INTO party_best_scores VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy', 'Legacy', 2, 7, 1000, 1);
  } finally {
    legacy.close();
  }
  const db = new Database(file);
  try {
    const board = new Leaderboard(db);
    const rows = board.list(2, '', 0).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].strokes).toBe(7);
    // The old row keeps its place and simply has no replay to link to.
    expect(rows[0].replayId).toBeNull();
    const columns = db
      .query('PRAGMA table_info(party_best_scores)')
      .all()
      .map((column) => column.name);
    expect(columns).toContain('replayId');
    // Rebuilding on the same file is not an error, and the new column is written.
    const upgraded = finalized('Legacy', 3, 500);
    upgraded.replayId = 'e'.repeat(32);
    upgraded.replayAvailable = true;
    new Leaderboard(db).record(upgraded);
    expect(board.list(2, '', 0).rows[0].replayId).toBe('e'.repeat(32));
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
