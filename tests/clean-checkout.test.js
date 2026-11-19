import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Reproducible installation: the archive must be inside the clone.
 *
 * `private-client/` is listed in .gitignore yet force-tracked, which is how a
 * clean `git archive` or fresh clone still carries all 275 originals — the
 * property docs/installation.md promises. If someone un-tracks the archive
 * (or a path slips out of the index), `prepare:client` starts failing on
 * clean checkouts while local builds keep working — the worst kind of drift.
 *
 * One `git ls-files` call, not one per path: per-file spawns can hit an index
 * lock while a parallel test runs `git archive`, which is a flake, not a
 * product failure. A single listing is atomic and hundreds of times faster.
 */

const root = path.resolve(import.meta.dir, '..');
const lock = JSON.parse(readFileSync(path.join(root, 'scripts/client-lock.json'), 'utf8'));

function trackedPaths() {
  const result = spawnSync('git', ['ls-files', 'private-client'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return new Set(result.stdout.trim().split('\n'));
}

test('every lock-pinned original is tracked in git', () => {
  const tracked = trackedPaths();
  const missing = Object.keys(lock).filter(
    (servedPath) => !tracked.has('private-client' + servedPath),
  );
  expect(missing).toEqual([]);
});

test('the archive stays complete: tracked count matches the lock', () => {
  expect(trackedPaths().size).toBe(Object.keys(lock).length);
});
