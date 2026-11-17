import { Database, type Statement } from 'bun:sqlite';
import { errorMessage, type CourseIndex } from './domain.js';
import type { RoomCheckpoint, RoomOptions } from './room-types.js';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { Room } from './room.js';

/** One checkpoint failure is logged, not repeated for every later frame. */
const PERSIST_FAILURE_REPORT_INTERVAL_MS = 60_000;

export class RoomStore {
  readonly db: Database;
  private readonly put: Statement<unknown, [string, number, string]>;
  private readonly del: Statement<unknown, [string]>;
  private lastFailureReportAt = 0;

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
    } catch (error) {
      this.reportFailure('save', error);
    }
  }
  remove(code: string) {
    try {
      this.del.run(code);
    } catch (error) {
      this.reportFailure('remove', error);
    }
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
    const rooms = new Map();
    for (const row of this.db.query<{ payload: string }, []>('SELECT payload FROM rooms').all()) {
      try {
        const data: RoomCheckpoint = JSON.parse(row.payload);
        if (data.version !== 1) {
          continue;
        }
        const room = new Room(data.code, catalog, {
          ...options,
          onChange: (changedRoom) => this.save(changedRoom),
        });
        room.restore(data);
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
