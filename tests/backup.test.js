import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, statSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * The backup tool.
 *
 * A backup is only worth having if it restores, and the failure this guards
 * against is specific to SQLite in WAL mode: recent commits can live only in the
 * `-wal` file, so copying the database by hand captures a stale or torn state.
 * The tests therefore drive the real script against a real database rather than
 * mocking SQLite, and they assert the artifact is complete on its own.
 */
const script = join(import.meta.dir, '..', 'scripts', 'backup.py');

/**
 * Every test here drives the real tool in a child process, and a few of them run
 * it half a dozen times. Bun's default five-second limit is a bound on logic, not
 * on process startup: under a full parallel suite these were intermittently
 * failing at 5.0 s without anything being wrong. The bound is raised rather than
 * the assertions relaxed - a genuine hang still fails, just later.
 */
const SPAWN_TIMEOUT_MS = 30_000;
const spawnTest = (name, fn) => test(name, fn, SPAWN_TIMEOUT_MS);

function run(arguments_) {
  const result = spawnSync('python3', [script, ...arguments_], { encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** A database in the shape the service creates, with `rooms` rows in its WAL. */
function liveDatabase(directory, rooms) {
  const filename = join(directory, 'rooms.sqlite');
  const database = new Database(filename, { create: true });
  database.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS rooms(code TEXT PRIMARY KEY, updated INTEGER NOT NULL, payload TEXT NOT NULL)',
  );
  const insert = database.prepare('INSERT INTO rooms VALUES(?,?,?)');
  for (const code of rooms) {
    insert.run(
      code,
      Date.now(),
      JSON.stringify({ version: 1, code, hostToken: 'secret-' + code, issued: [] }),
    );
  }
  // Left open on purpose: the rows are committed to the WAL, which is exactly
  // the state a naive copy loses.
  return { filename, database };
}

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), 'bp-backup-test-'));
}

spawnTest('a backup of a live database captures rows still in the write-ahead log', () => {
  const directory = temporaryDirectory();
  const { filename, database } = liveDatabase(directory, ['AAAAA', 'BBBBB', 'CCCCC']);
  const walPath = filename + '-wal';
  // Precondition: the rows really are only in the WAL, which is what makes this
  // test about WAL consistency rather than about copying a settled file.
  expect(existsSync(walPath) && statSync(walPath).size > 0).toBe(true);
  try {
    const created = run(['create', '--db', filename, '--directory', join(directory, 'backups')]);
    expect(created.err).toBe('');
    expect(created.code).toBe(0);
    expect(created.out).toContain('rooms: 3');
    expect(created.out).toContain('rooms-');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

spawnTest('the backup is one file, not a set with a write-ahead log beside it', () => {
  const directory = temporaryDirectory();
  const { filename, database } = liveDatabase(directory, ['AAAAA']);
  const backups = join(directory, 'backups');
  try {
    expect(run(['create', '--db', filename, '--directory', backups]).code).toBe(0);
    const files = readdirSync(backups);
    // A `-wal` or `-shm` companion would make the artifact incomplete on its own.
    expect(files.filter((name) => name.endsWith('.sqlite'))).toHaveLength(1);
    expect(files.filter((name) => name.endsWith('-wal') || name.endsWith('-shm'))).toHaveLength(0);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

spawnTest('a backup and its directory are private to their owner', () => {
  const directory = temporaryDirectory();
  const { filename, database } = liveDatabase(directory, ['AAAAA']);
  const backups = join(directory, 'backups');
  try {
    expect(run(['create', '--db', filename, '--directory', backups]).code).toBe(0);
    // These files carry identity sessions and host capabilities.
    expect(statSync(backups).mode & 0o777).toBe(0o700);
    const backup = readdirSync(backups).find((name) => name.endsWith('.sqlite'));
    expect(statSync(join(backups, backup)).mode & 0o777).toBe(0o600);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

spawnTest('verify refuses a backup that is readable beyond its owner', () => {
  const directory = temporaryDirectory();
  const { filename, database } = liveDatabase(directory, ['AAAAA']);
  const backups = join(directory, 'backups');
  try {
    expect(run(['create', '--db', filename, '--directory', backups]).code).toBe(0);
    const backup = join(
      backups,
      readdirSync(backups).find((name) => name.endsWith('.sqlite')),
    );
    chmodSync(backup, 0o644);
    const verified = run(['verify', backup]);
    expect(verified.code).toBe(1);
    expect(verified.err).toContain('readable beyond its owner');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

spawnTest(
  'verify reports a checkpoint version this build cannot read instead of passing silently',
  () => {
    const directory = temporaryDirectory();
    const { filename, database } = liveDatabase(directory, ['AAAAA']);
    const backups = join(directory, 'backups');
    try {
      expect(run(['create', '--db', filename, '--directory', backups]).code).toBe(0);
      const backup = join(
        backups,
        readdirSync(backups).find((name) => name.endsWith('.sqlite')),
      );
      // Rewrite every row as a future version, which is what a rollback meets.
      const rewritten = new Database(backup);
      rewritten.exec(
        'UPDATE rooms SET payload = replace(payload, \'"version":1\', \'"version":2\')',
      );
      rewritten.close();
      const verified = run(['verify', backup]);
      // The file is intact, so verify succeeds, but it must say no room is current
      // rather than implying this build could start with them.
      expect(verified.code).toBe(0);
      expect(verified.out).toContain('checkpoint version 2');
      expect(verified.out).toContain('would skip every room');
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

spawnTest('verify rejects a file that is not a room database', () => {
  const directory = temporaryDirectory();
  const { filename, database } = liveDatabase(directory, ['AAAAA']);
  try {
    const notADatabase = join(directory, 'not-a-backup.sqlite');
    chmodSync(filename, 0o600);
    const created = run(['create', '--db', filename, '--directory', join(directory, 'backups')]);
    expect(created.code).toBe(0);
    // An empty SQLite file has no `rooms` table.
    const empty = new Database(notADatabase, { create: true });
    empty.exec('CREATE TABLE unrelated(x)');
    empty.close();
    chmodSync(notADatabase, 0o600);
    const verified = run(['verify', notADatabase]);
    expect(verified.code).toBe(1);
    expect(verified.err).toContain('no rooms table');
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

spawnTest('prune keeps the newest backups and never removes the last one', () => {
  const directory = temporaryDirectory();
  const { filename, database } = liveDatabase(directory, ['AAAAA']);
  const backups = join(directory, 'backups');
  try {
    for (let index = 0; index < 4; index++) {
      // Distinct timestamps, so the ordering the prune relies on is well defined.
      const created = run(['create', '--db', filename, '--directory', backups]);
      expect(created.code).toBe(0);
      spawnSync('sleep', ['0.02']);
    }
    const all = readdirSync(backups).filter((name) => name.endsWith('.sqlite'));
    expect(all.length).toBe(4);
    const newest = all.sort().at(-1);
    const pruned = run(['prune', '--directory', backups, '--keep', '2']);
    expect(pruned.code).toBe(0);
    const remaining = readdirSync(backups).filter((name) => name.endsWith('.sqlite'));
    expect(remaining).toHaveLength(2);
    // The newest file must survive, since that is the one a restore would want.
    expect(remaining).toContain(newest);
    // A keep of zero would delete every backup, so it is refused.
    const refused = run(['prune', '--directory', backups, '--keep', '0']);
    expect(refused.code).toBe(1);
    expect(readdirSync(backups).filter((name) => name.endsWith('.sqlite'))).toHaveLength(2);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

spawnTest('a backed-up database opens in the service and keeps its rooms', () => {
  const directory = temporaryDirectory();
  const { filename, database } = liveDatabase(directory, ['REST1', 'REST2']);
  const backups = join(directory, 'backups');
  try {
    expect(run(['create', '--db', filename, '--directory', backups]).code).toBe(0);
    const backup = join(
      backups,
      readdirSync(backups).find((name) => name.endsWith('.sqlite')),
    );
    // Opening it the way the service does must find both rooms: this is the
    // restore path, and it is the assertion that makes the tool meaningful.
    const restored = new Database(backup);
    restored.exec('PRAGMA journal_mode=WAL');
    const codes = restored.query('SELECT code FROM rooms ORDER BY code').all();
    expect(codes.map((row) => row.code)).toEqual(['REST1', 'REST2']);
    const payload = JSON.parse(restored.query('SELECT payload FROM rooms LIMIT 1').get().payload);
    // The capability travels with the checkpoint, which is why these files are
    // private; a restore that dropped it would strand every returning player.
    expect(payload.hostToken).toBe('secret-REST1');
    restored.close();
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
