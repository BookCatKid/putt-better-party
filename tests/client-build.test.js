import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readClientBuild } from '../src/client-build.js';

/**
 * The prepared-client stamp.
 *
 * Its job is to make a *stale but complete* client detectable. A `web/` left over
 * from an earlier checkout starts without error and serves patches that do not
 * match the server, so the symptom is a button that does nothing. These tests pin
 * both halves: a real stamp is read, and anything unreadable reports "unknown"
 * rather than stopping the service or inventing a value.
 */

function withTempWeb(files) {
  const directory = mkdtempSync(path.join(tmpdir(), 'bp-client-build-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(directory, name), content);
  }
  return directory;
}

test('a stamped build is reported as written', async () => {
  const directory = withTempWeb({
    'build.json': JSON.stringify({ clientBuild: 'abcdef0123456789', assets: 275 }),
  });
  try {
    expect(await readClientBuild(directory)).toEqual({
      clientBuild: 'abcdef0123456789',
      assets: 275,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an absent stamp is unknown rather than an error', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bp-client-build-'));
  try {
    // A container mount or a pre-stamp client legitimately has no stamp, so this
    // must not throw and must not be confused with a recognised build.
    expect(await readClientBuild(directory)).toBe(null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a malformed stamp is unknown rather than a partial reading', async () => {
  const cases = [
    'not json at all',
    JSON.stringify(['an', 'array']),
    JSON.stringify({ clientBuild: 'abc' }),
    JSON.stringify({ assets: 12 }),
  ];
  for (const content of cases) {
    const directory = withTempWeb({ 'build.json': content });
    try {
      expect(await readClientBuild(directory)).toBe(null);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('a nested directory is not mistaken for a stamp', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'bp-client-build-'));
  mkdirSync(path.join(directory, 'build.json'));
  try {
    expect(await readClientBuild(directory)).toBe(null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
