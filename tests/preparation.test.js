import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Atomic preparation.
 *
 * `scripts/prepare-client.py` used to delete the live `web/` and then copy and
 * patch into it, so a patch failure or an interrupt left a half-prepared client
 * on disk for the running server to serve. Preparation now builds into a staging
 * directory, syntax-checks every patched bundle, and publishes with a directory
 * rename. These tests pin that contract from the outside:
 *
 *  1. The prepared build exists and is self-consistent.
 *  2. A failing patch leaves the live build byte-identical and leaves no staging
 *     directories behind.
 *  3. The patcher refuses to run outside preparation, so it cannot be pointed at
 *     the live directory by accident.
 *  4. The immutable archive is never written to.
 *
 * They deliberately run the real script rather than a mock, because the failure
 * being guarded against is a real filesystem one. The single slow case is skipped
 * unless `BP_ATOMIC_SLOW=1`, since a full preparation re-hashes 275 files.
 */

const root = path.resolve(import.meta.dir, '..');
const prepared = path.join(root, 'web');
const archived = path.join(root, 'private-client');

const stagingStrays = () =>
  readdirSync(root).filter(
    (entry) => entry.startsWith('.web-staging-') || entry.startsWith('.web-previous-'),
  );

const fingerprint = (directory) => {
  const entries = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        walk(full);
      } else {
        entries.push(`${path.relative(directory, full)}:${stats.size}:${stats.mtimeMs}`);
      }
    }
  };
  walk(directory);
  return entries;
};

test('the prepared client exists and its entry modules are present', () => {
  expect(existsSync(prepared)).toBe(true);
  // The entry, one lazily loaded route, and the generated validator closure.
  expect(existsSync(path.join(prepared, 'assets/index-DFMxt6BL.js'))).toBe(true);
  expect(existsSync(path.join(prepared, 'assets/party._code-D3a-IB4-.js'))).toBe(true);
  expect(existsSync(path.join(prepared, 'validation/specValidation-vqop-JBL.js'))).toBe(true);
  expect(existsSync(path.join(prepared, 'assets/bp-home.js'))).toBe(true);
  expect(existsSync(path.join(prepared, 'assets/bp-leaderboard.js'))).toBe(true);
});

test('preparation writes no generated output into the immutable archive', () => {
  // The validation closure is generated, so it belongs to the prepared build. It
  // used to be written under private-client/, which holds hash-pinned originals.
  expect(existsSync(path.join(archived, 'validation'))).toBe(false);
});

test('the patcher refuses to run outside preparation', () => {
  const result = spawnSync('python3', [path.join(root, 'scripts/patch-client.py')], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, BP_STAGE_WEB: '' },
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('must run through prepare-client.py');
});

test('a failing patch leaves the live build intact and no staging behind', () => {
  // Break an authored module that is spliced into a patched bundle, so the failure
  // happens after staging has begun but before publication.
  const target = path.join(root, 'scripts/party-runtime.js');
  const original = readFileSync(target, 'utf8');
  const before = fingerprint(prepared);
  expect(stagingStrays()).toEqual([]);

  try {
    writeFileSync(target, `${original}\nexport const deliberatelyBroken = ;\n`);
    const result = spawnSync('python3', [path.join(root, 'scripts/prepare-client.py')], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    // The prepared client must be byte-for-byte what it was, not a partial build.
    expect(fingerprint(prepared)).toEqual(before);
    expect(stagingStrays()).toEqual([]);
  } finally {
    writeFileSync(target, original);
    for (const stray of stagingStrays()) {
      rmSync(path.join(root, stray), { recursive: true, force: true });
    }
  }
});

test('a successful preparation publishes a complete build and cleans up', () => {
  const result = spawnSync('python3', [path.join(root, 'scripts/prepare-client.py')], {
    cwd: root,
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Syntax-checked');
  expect(result.stdout).toContain('Cross-checked');
  expect(stagingStrays()).toEqual([]);

  // Every pinned file must be present in the published build.
  const lock = JSON.parse(readFileSync(path.join(root, 'scripts/client-lock.json'), 'utf8'));
  const missing = Object.keys(lock).filter(
    (entry) => !existsSync(path.join(prepared, entry.replace(/^\//, ''))),
  );
  expect(missing).toEqual([]);
}, 300_000);
