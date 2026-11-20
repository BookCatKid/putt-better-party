import { Database, type Statement } from 'bun:sqlite';
import { errorMessage, type CourseIndex } from './domain.js';
import type { RoomOptions } from './room-types.js';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { Room } from './room.js';
import { parseStoredRoomPayload } from './persistence-validation.js';

/** One checkpoint failure is logged, not repeated for every later frame. */
const PERSIST_FAILURE_REPORT_INTERVAL_MS = 60_000;

export class RoomStore {
  readonly db: Database;
  private readonly put: Statement<unknown, [string, number, string]>;
  private readonly del: Statement<unknown, [string]>;
  private lastFailureReportAt = 0;
  private writes = 0;
  private deletes = 0;

  constructor(filename: string) {
    if (filename !== ':memory:') {
      mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(filename, { create: true });
    if (filename !== ':memory:') {
      chmodSync(filename, 0o600);
    }
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS rooms(code TEXT PRIMARY KEY, updated INTEGER NOT NULL, payload TEXT NOT NULL)',
    );
    this.put = this.db.prepare(
      'INSERT INTO rooms VALUES(?,?,?) ON CONFLICT(code) DO UPDATE SET updated=excluded.updated,payload=excluded.payload',
    );
    this.del = this.db.prepare('DELETE FROM rooms WHERE code=?');
  }
  save(room: Room) {
    try {
      this.put.run(room.code, room.lastActivity, JSON.stringify(room.checkpoint()));
      this.writes += 1;
    } catch (error) {
      this.reportFailure('save', error);
    }
  }
  remove(code: string) {
    try {
      // A DELETE that matches no row still succeeds; the statement's `changes`
      // is what makes the counter mean "rows removed" rather than "statements
      // issued", so a sweep walking rooms already gone does not look like work.
      this.deletes += this.del.run(code).changes;
    } catch (error) {
      this.reportFailure('remove', error);
    }
  }
  /**
   * Checkpoint counts for the health report: how busy the write side has been,
   * never what was written.
   */
  stats() {
    return { writes: this.writes, deletes: this.deletes };
  }
  /**
   * A failed checkpoint must not terminate the service. The room keeps playing
   * from memory and the next successful save rewrites the row, so the only
   * consequence of a full disk or locked database is lost restart recovery.
   */
  private reportFailure(operation: string, error: unknown) {
    const now = Date.now();
    if (now - this.lastFailureReportAt < PERSIST_FAILURE_REPORT_INTERVAL_MS) {
      return;
    }
    this.lastFailureReportAt = now;
    console.error(`Could not ${operation} room state: ${errorMessage(error)}`);
  }
  load(catalog: CourseIndex, options: RoomOptions = {}, now = Date.now()): Map<string, Room> {
    this.db.query('DELETE FROM rooms WHERE updated<?').run(now - 1800000);
    const rooms = new Map<string, Room>();
    for (const row of this.db
      .query<{ code: string; payload: string }, []>('SELECT code, payload FROM rooms')
      .all()) {
      /*
       * A stored row is untrusted input: it may have been truncated by a crash,
       * written by another build, or edited by hand. Validate it before touching
       * Room.restore, and skip anything that does not describe a whole room.
       *
       * A skipped row is deliberately left in place rather than deleted or
       * overwritten. Deleting destroys the only copy of credentials a player
       * might still hold, and rewriting it would silently discard play data that
       * a later migration could repair. The age sweep at the top of this method
       * already removes rows after 30 minutes of inactivity, so a bad row cannot
       * linger indefinitely, and an operator can inspect it in the meantime.
       */
      try {
        const parsed = parseStoredRoomPayload(row.payload);
        if (!parsed.ok) {
          console.error(
            `Skipped stored room ${JSON.stringify(row.code)} (${parsed.kind}): ${parsed.reason}`,
          );
          continue;
        }
        if (parsed.checkpoint.code !== row.code) {
          // The checkpoint and the row it was stored under disagree, so one of
          // them was rewritten or the row was copied between keys. Trusting the
          // payload would resurrect a room under a code the client never used.
          console.error(
            `Skipped stored room ${JSON.stringify(row.code)} (corrupt): payload names the room ${JSON.stringify(parsed.checkpoint.code)}`,
          );
          continue;
        }
        const room = new Room(parsed.checkpoint.code, catalog, {
          ...options,
          onChange: (changedRoom) => this.save(changedRoom),
        });
        room.restore(parsed.checkpoint);
        rooms.set(room.code, room);
        this.save(room);
      } catch (error) {
        console.error('Could not recover a stored room:', errorMessage(error));
      }
    }
    return rooms;
  }
  close() {
    this.db.close();
  }
}
