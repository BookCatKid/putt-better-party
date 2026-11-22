import type { Database } from 'bun:sqlite';
import type { Room } from './room.js';

export interface BestScore {
  name: string;
  holes: number;
  strokes: number;
  timeMs: number;
  achievedAt: number;
  /** The match whose replays document this score, when one was recorded. */
  replayId: string | null;
}
export function eligibleScores(room: Room, now = Date.now()): BestScore[] {
  if (
    room.phase !== 'final' ||
    room.config.mapSource !== 'random' ||
    room.config.courseVoting ||
    !room.recordEligible ||
    room.roundHistory.length !== room.config.holes ||
    !room.roundHistory.every(
      (round, index) => round.status === 'completed' && round.index === index,
    )
  ) {
    return [];
  }
  return [...room.players.values()].flatMap((player) => {
    const rows = room.roundHistory.map((round) => round.rows.find((row) => row.uid === player.uid));
    if (
      !rows.every(
        (row) =>
          row?.status === 'holed' &&
          Number.isInteger(row.strokes) &&
          (row.strokes ?? 0) >= 1 &&
          typeof row.timeMs === 'number' &&
          Number.isFinite(row.timeMs) &&
          row.timeMs >= 0,
      )
    ) {
      return [];
    }
    return [
      {
        name: player.name,
        holes: room.config.holes,
        strokes: rows.reduce((total, row) => total + (row?.strokes ?? 0), 0),
        timeMs: rows.reduce((total, row) => total + (row?.timeMs ?? 0), 0),
        achievedAt: now,
        // Only claim a replay that was actually written; the read path still
        // checks the archive before advertising a link, because a later prune can
        // remove a match the leaderboard outlives.
        replayId: room.replayAvailable ? room.replayId : null,
      },
    ];
  });
}
export class Leaderboard {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS party_best_scores (
      name_key TEXT NOT NULL, name TEXT NOT NULL, holes INTEGER NOT NULL,
      strokes INTEGER NOT NULL, timeMs INTEGER NOT NULL, achievedAt INTEGER NOT NULL,
      replayId TEXT,
      PRIMARY KEY (name_key, holes)
    ); CREATE INDEX IF NOT EXISTS party_best_rank ON party_best_scores(holes, strokes, timeMs, achievedAt);`);
    this.addReplayColumn();
  }
  /**
   * Add `replayId` to a table created before it existed.
   *
   * `CREATE TABLE IF NOT EXISTS` does nothing when the table is already there, so a
   * database written by an earlier build keeps its old shape. The rows it holds
   * remain valid — they simply have no replay to link to — and that is the right
   * outcome, because the matches they describe are long gone from the archive.
   */
  private addReplayColumn() {
    const columns = this.db
      .query<{ name: string }, []>('PRAGMA table_info(party_best_scores)')
      .all();
    if (!columns.some((column) => column.name === 'replayId')) {
      this.db.exec('ALTER TABLE party_best_scores ADD COLUMN replayId TEXT');
    }
  }
  record(room: Room) {
    const scores = eligibleScores(room);
    if (!scores.length) {
      return;
    }
    const upsert = this.db.query(`INSERT INTO party_best_scores
      (name_key, name, holes, strokes, timeMs, achievedAt, replayId)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name_key, holes) DO UPDATE SET name=excluded.name, strokes=excluded.strokes,
      timeMs=excluded.timeMs, achievedAt=excluded.achievedAt, replayId=excluded.replayId
      WHERE excluded.strokes < party_best_scores.strokes OR
      (excluded.strokes = party_best_scores.strokes AND excluded.timeMs < party_best_scores.timeMs)`);
    this.db.transaction(() => {
      for (const score of scores) {
        upsert.run(
          score.name.normalize('NFKC').toLowerCase(),
          score.name,
          score.holes,
          score.strokes,
          score.timeMs,
          score.achievedAt,
          score.replayId,
        );
      }
    })();
  }
  list(holes: number, search: string, offset: number) {
    const query =
      '%' +
      search
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\\%_]/g, (char) => '\\' + char) +
      '%';
    const rows = this.db
      .query<BestScore & { rank: number }, [number, string, number]>(
        `WITH ranked AS (SELECT name, holes, strokes, timeMs, achievedAt, replayId,
        ROW_NUMBER() OVER (ORDER BY strokes, timeMs, achievedAt, name_key) AS rank, name_key
        FROM party_best_scores WHERE holes = ?)
        SELECT name, holes, strokes, timeMs, achievedAt, replayId, rank FROM ranked
        WHERE name_key LIKE ? ESCAPE '\\' ORDER BY rank LIMIT 101 OFFSET ?`,
      )
      .all(holes, query, offset);
    return { rows: rows.slice(0, 100), nextOffset: rows.length > 100 ? offset + 100 : null };
  }
}
