import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * The version-diff report: dependencies, registry media and patch anchors.
 *
 * `diff-capture.py` is read-only by contract - it classifies a staged capture
 * against the lock, runs the capture's own registry discovery over both bundle
 * sets, and dry-runs every patch body against the new bundles by logical name.
 * The fixtures here build a synthetic capture with a deliberately broken
 * anchor so the report's failure vocabulary is asserted, not just its shape.
 */

const root = path.resolve(import.meta.dir, '..');
const differ = path.join(root, 'scripts/diff-capture.py');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function runDiff(capture) {
  const result = spawnSync('python3', [differ, capture], { encoding: 'utf8' });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

test('a drifted anchor is named with its multiplicity evidence', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bp-diff-'));
  try {
    const capture = path.join(directory, 'snap');
    mkdirSync(path.join(capture, 'assets'), { recursive: true });
    // Same bundle, new hash suffix, one anchor deliberately removed: the
    // report must identify the anchor rather than just say "failed".
    const original = readFileSync(
      path.join(root, 'private-client/assets/GameRoot-7kMtVtdO.js'),
      'utf8',
    );
    const drifted = original.replace('children:Pt(c)', 'children:GONE(c)');
    writeFileSync(path.join(capture, 'assets/GameRoot-ZZZ99999.js'), drifted);
    const report = runDiff(capture);
    const root_anchor = report.anchors.find((entry) => entry.bundle === 'GameRoot-7kMtVtdO.js');
    expect(root_anchor.status).toBe('failed');
    expect(root_anchor.candidate).toBe('GameRoot-ZZZ99999.js');
    expect(root_anchor.detail).toContain('children:Pt(c)');
    // Bundles the capture does not carry report as missing, not failed.
    const index_anchor = report.anchors.find((entry) => entry.bundle === 'index-DFMxt6BL.js');
    expect(index_anchor.status).toBe('missing');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the pinned archive itself satisfies every anchor', () => {
  // The strongest baseline available offline: the archived snapshot is the
  // build the patcher was written against, so every anchor must report ok.
  const result = spawnSync(
    'python3',
    [
      path.join(root, 'scripts/patch-client.py'),
      '--check-anchors',
      path.join(root, 'private-client'),
    ],
    { encoding: 'utf8' },
  );
  expect(result.status).toBe(0);
  const anchors = JSON.parse(result.stdout);
  expect(anchors).toHaveLength(7);
  expect(new Set(anchors.map((entry) => entry.status))).toEqual(new Set(['ok']));
});

test('a capture of the archive reports zero media and texture drift', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bp-diff-'));
  try {
    const capture = path.join(directory, 'snap');
    // The capture convention is files at their served paths under the dir.
    cpSync(path.join(root, 'private-client'), capture, { recursive: true });
    const report = runDiff(capture);
    expect(report.media).toEqual({ added: [], removed: [] });
    expect(report.textures).toEqual({ added: [], removed: [] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('dependency classification composes with the diff report', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bp-diff-'));
  try {
    const capture = path.join(directory, 'snap');
    mkdirSync(path.join(capture, 'assets'), { recursive: true });
    writeFileSync(path.join(capture, 'assets/NewThing-AAA99999.js'), 'new-module');
    writeFileSync(
      path.join(capture, 'manifest.json'),
      JSON.stringify({
        entry: '/assets/NewThing-AAA99999.js',
        assets: {
          '/assets/NewThing-AAA99999.js': { sha256: sha256('new-module'), bytes: 10 },
        },
        missing: {},
      }),
    );
    const report = runDiff(capture);
    expect(report.dependencies.ok).toBe(true);
    expect(report.dependencies.added).toEqual(['/assets/NewThing-AAA99999.js']);
    // The tool is read-only: no lock update, no staged build, nothing written.
    expect(report.dependencies.counts.removed).toBe(
      Object.keys(JSON.parse(readFileSync(path.join(root, 'scripts/client-lock.json'), 'utf8')))
        .length,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
