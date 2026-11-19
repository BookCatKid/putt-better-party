import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * The capture-to-lock workflow verdict.
 *
 * `verify-capture.py` is what turns a staged `captures/<snapshot>` directory
 * into an adoption decision, and its exit codes are the distinct reporting
 * this item requires: 0 complete, 1 incomplete, 2 unreadable. Each scenario
 * builds a minimal synthetic capture plus a one-entry lock, so every
 * classification - unchanged, changed, added, removed, missing, mismatched,
 * unparseable - is asserted against a controlled fixture rather than the
 * repository's real lock.
 */

const root = path.resolve(import.meta.dir, '..');
const verifier = path.join(root, 'scripts/verify-capture.py');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Write a fixture capture + lock, then run the verifier and parse its JSON. */
function verify({ manifest, files = {}, lock, manifestText }) {
  const directory = mkdtempSync(path.join(tmpdir(), 'bp-capture-'));
  try {
    const capture = path.join(directory, 'snap');
    mkdirSync(capture, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(capture, name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    if (manifest !== undefined) {
      writeFileSync(path.join(capture, 'manifest.json'), JSON.stringify(manifest));
    } else if (manifestText !== undefined) {
      writeFileSync(path.join(capture, 'manifest.json'), manifestText);
    }
    const lockPath = path.join(directory, 'lock.json');
    writeFileSync(lockPath, JSON.stringify(lock));
    const result = spawnSync('python3', [verifier, '--lock', lockPath, capture], {
      encoding: 'utf8',
    });
    return { code: result.status, verdict: JSON.parse(result.stdout) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a complete compatible capture verifies installable', () => {
  const bundle = 'entry-bytes';
  const { code, verdict } = verify({
    files: { 'assets/index-AAAAAAAA.js': bundle },
    manifest: {
      entry: '/assets/index-AAAAAAAA.js',
      assets: { '/assets/index-AAAAAAAA.js': { sha256: sha256(bundle), bytes: 11 } },
      missing: {},
    },
    lock: { '/assets/index-BBBBBBBB.js': sha256(bundle) },
  });
  expect(code).toBe(0);
  expect(verdict.ok).toBe(true);
  // The lock's old hash-named bundle was superseded by an identical new one.
  expect(verdict.counts.removed).toBe(1);
  expect(verdict.counts.added).toBe(1);
});

test('an unchanged asset and a changed asset classify separately', () => {
  const same = 'same-bytes';
  const next = 'next-bundle-bytes';
  const { code, verdict } = verify({
    files: { 'models/a.glb': same, 'assets/b-CCCCCCCC.js': next },
    manifest: {
      entry: '/assets/index-AAAAAAAA.js',
      assets: {
        '/models/a.glb': { sha256: sha256(same) },
        '/assets/b-CCCCCCCC.js': { sha256: sha256(next) },
      },
      missing: {},
    },
    lock: {
      '/models/a.glb': sha256(same),
      '/assets/b-DDDDDDDD.js': sha256('previous-bundle-bytes'),
    },
  });
  expect(code).toBe(0);
  expect(verdict.counts.unchanged).toBe(1);
  expect(verdict.counts.added).toBe(1);
  expect(verdict.counts.removed).toBe(1);
});

test('a newly discovered logical module reports as added, not ignored', () => {
  const { verdict } = verify({
    files: { 'assets/brand-new-EEEEEEEE.js': 'new-module' },
    manifest: {
      entry: '/assets/index-AAAAAAAA.js',
      assets: { '/assets/brand-new-EEEEEEEE.js': { sha256: sha256('new-module') } },
      missing: {},
    },
    lock: {},
  });
  expect(verdict.ok).toBe(true);
  expect(verdict.added).toEqual(['/assets/brand-new-EEEEEEEE.js']);
});

test('a recorded fetch failure reports incomplete distinctly', () => {
  const { code, verdict } = verify({
    files: {},
    manifest: {
      entry: '/assets/index-AAAAAAAA.js',
      assets: {},
      missing: { '/assets/gone-FFFFFFFF.js': 'HTTP 404' },
    },
    lock: { '/assets/gone-FFFFFFFF.js': sha256('whatever') },
  });
  expect(code).toBe(1);
  expect(verdict.ok).toBe(false);
  // The missing entry carries its own diagnostic - the capture is preserved
  // precisely because it can say *why* it is incomplete.
  expect(verdict.missing['/assets/gone-FFFFFFFF.js']).toBe('HTTP 404');
});

test('captured bytes that contradict their manifest are incomplete', () => {
  const { code, verdict } = verify({
    files: { 'assets/x-12345678.js': 'on-disk-bytes' },
    manifest: {
      entry: '/assets/index-AAAAAAAA.js',
      assets: { '/assets/x-12345678.js': { sha256: sha256('different-bytes') } },
      missing: {},
    },
    lock: {},
  });
  expect(code).toBe(1);
  expect(verdict.mismatched[0].problem).toBe('hash-mismatch');
});

test('a file the manifest does not describe is incomplete too', () => {
  const { code, verdict } = verify({
    files: {},
    manifest: {
      entry: '/assets/index-AAAAAAAA.js',
      assets: { '/assets/phantom-99999999.js': { sha256: sha256('x') } },
      missing: {},
    },
    lock: {},
  });
  expect(code).toBe(1);
  expect(verdict.mismatched[0].problem).toBe('manifest-without-file');
});

test('an unparseable manifest fails the run itself, not the verdict', () => {
  const { code, verdict } = verify({
    manifestText: '{ not json',
    lock: {},
  });
  expect(code).toBe(2);
  expect(verdict.reason).toBe('unreadable-manifest');
});

test('a missing capture directory is unreadable, not incomplete', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bp-capture-'));
  try {
    const result = spawnSync(
      'python3',
      [verifier, '--lock', path.join(directory, 'lock.json'), path.join(directory, 'gone')],
      { encoding: 'utf8' },
    );
    // The lock file never gets read - the capture is refused first.
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).reason).toBe('no-such-capture');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
