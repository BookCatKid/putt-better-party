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
 * This test pins the invariant directly: every file the lock names is in the
 * git index, and the lock names what the archive holds.
 */

const root = path.resolve(import.meta.dir, '..');
const lock = JSON.parse(readFileSync(path.join(root, 'scripts/client-lock.json'), 'utf8'));

function tracked(relativePath) {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', relativePath], {
    cwd: root,
    encoding: 'utf8',
  });
  return result.status === 0;
}

test('every lock-pinned original is tracked in git', () => {
  const missing = Object.keys(lock).filter((servedPath) => !tracked('private-client' + servedPath));
  expect(missing).toEqual([]);
});

test('the archive stays complete: tracked count matches the lock', () => {
  const result = spawnSync('git', ['ls-files', 'private-client'], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  const trackedCount = result.stdout.trim().split('\n').length;
  expect(trackedCount).toBe(Object.keys(lock).length);
});
