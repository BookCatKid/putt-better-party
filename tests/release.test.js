import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * The release tool.
 *
 * The thing worth guarding is not that a tarball can be produced — it is that the
 * tarball carries **no proprietary client**. The original game client is tracked
 * in Git under `private-client/`, so a naive `git archive` puts 287 of its files
 * into every release artefact, and that would be a redistribution. These tests
 * drive the real script and assert the refusal, not just the happy path.
 *
 * The version checks exist because the alternative is discovering, after
 * publishing, that the manifest says one thing and the changelog says another.
 */

const script = join(import.meta.dir, '..', 'scripts', 'release.py');

function run(arguments_) {
  const result = spawnSync('python3', [script, ...arguments_], { encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), 'bp-release-test-'));
}

/** A tarball with the given relative paths, to test what `verify` refuses. */
function tarballWith(directory, name, files) {
  const source = join(directory, 'source-' + name);
  for (const file of files) {
    const target = join(source, file);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, 'content of ' + file);
  }
  const archive = join(directory, name + '.tar.gz');
  const result = spawnSync('tar', ['-czf', archive, '-C', source, ...files], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  return archive;
}

const manifestVersion = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
).version;

test('the manifest version and the changelog agree', () => {
  const result = run(['check']);
  expect(result.err).toBe('');
  expect(result.code).toBe(0);
  expect(result.out).toContain(`version ${manifestVersion} matches CHANGELOG.md`);
});

test('a tag that disagrees with the manifest is refused', () => {
  const result = run(['check', '--tag', 'v999.0.0']);
  expect(result.code).toBe(1);
  expect(result.err).toContain('does not match package.json version');
  expect(result.err).toContain(manifestVersion);
});

test('a tag that agrees with the manifest is accepted', () => {
  const result = run(['check', '--tag', 'v' + manifestVersion]);
  expect(result.code).toBe(0);
  expect(result.out).toContain(`tag v${manifestVersion}`);
});

test(
  'the archive of HEAD is source only and reproducible',
  () => {
    const directory = temporaryDirectory();
    try {
      const first = join(directory, 'first.tar.gz');
      const second = join(directory, 'second.tar.gz');
      expect(run(['archive', '--output', first]).code).toBe(0);
      expect(run(['archive', '--output', second]).code).toBe(0);
      // Reproducible releases are the point of building from a commit rather than a
      // working tree: the same commit must produce the same bytes.
      expect(readFileSync(first).equals(readFileSync(second))).toBe(true);

      const listing = spawnSync('tar', ['-tzf', first], { encoding: 'utf8' });
      const members = listing.stdout.split('\n').filter(Boolean);
      expect(members.some((name) => name.startsWith('private-client/'))).toBe(false);
      expect(members.some((name) => name.startsWith('src/'))).toBe(true);
      expect(members).toContain('package.json');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  // Two real tar invocations over the full tree; generous budget for loaded CI.
  30_000,
);

test('an archive carrying the archived client is refused', () => {
  const directory = temporaryDirectory();
  try {
    const archive = tarballWith(directory, 'leaky', [
      'private-client/assets/date-D4dx3Sc1.js',
      'src/server.ts',
    ]);
    const result = run(['verify', archive]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('proprietary member');
    expect(result.err).toContain('private-client/assets/date-D4dx3Sc1.js');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a locked asset moved out of the archive path is still refused', () => {
  const directory = temporaryDirectory();
  try {
    // The lock is by basename, so relocating an original does not smuggle it past
    // the check that looks only at the directory prefix.
    const archive = tarballWith(directory, 'moved', ['src/date-D4dx3Sc1.js']);
    const result = run(['verify', archive]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('src/date-D4dx3Sc1.js');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a verify of a missing file is an error, not a pass', () => {
  const result = run(['verify', '/tmp/bp-release-does-not-exist.tar.gz']);
  expect(result.code).toBe(1);
  expect(result.err).toContain('does not exist');
});

test('an uncommitted version bump is refused, because the archive is built from HEAD', () => {
  // This is a defect that was found by probing rather than by reading: the check
  // read package.json from the working tree while `git archive` used HEAD, so a
  // dirty tree claiming 1.0.1 passed while the archive shipped 1.0.0. A release
  // describes a commit, so the working tree must match it.
  const before = readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8');
  const manifestPath = join(import.meta.dir, '..', 'package.json');
  const manifest = JSON.parse(before);
  try {
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, version: '0.0.0-probe' }, null, 2) + '\n',
    );
    const result = run(['check']);
    expect(result.code).toBe(1);
    expect(result.err).toContain('uncommitted changes');
  } finally {
    writeFileSync(manifestPath, before);
  }
  // Restoring the file must leave the check passing again.
  expect(run(['check']).code).toBe(0);
});
