import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Deterministic fixtures: the unit suite must be reproducible offline.
 *
 * The contract is that `bun test` passes identically on an airplane and under
 * CI — every course spec is synthetic or independently authored, every
 * "upstream" answer comes from the mock adapter, and the only real upstream
 * traffic lives in `tests/integration/`, which is a separate, explicitly
 * live-catalog suite. These tests pin that boundary so a future test cannot
 * quietly start depending on the network or on persisted official data.
 */

const root = path.resolve(import.meta.dir, '..');
const unitTestFiles = readdirSync(path.join(root, 'tests'))
  .filter((name) => name.endsWith('.test.js'))
  .map((name) => path.join(root, 'tests', name));

test('no unit test references the upstream origin', () => {
  // putt.day is the only upstream the code knows (UPSTREAM_ORIGIN). A unit
  // test naming it could only be trying to reach it — the adapter mock exists
  // precisely so none ever should.
  for (const file of unitTestFiles) {
    // This guard file names the origin in its own documentation; every other
    // file that names it is trying to reach it.
    if (file.endsWith('fixtures-determinism.test.js')) {
      continue;
    }
    const source = readFileSync(file, 'utf8');
    expect(source.includes('putt.day'), `${path.basename(file)} references the live upstream`).toBe(
      false,
    );
  }
});

test('no persisted official playable catalog exists in the repo', () => {
  // A checked-in copy of real course data would be both a determinism hazard
  // (upstream mutates underneath the fixture) and a redistribution of game
  // content. Fixtures must be authored, not captured — and an authored minimal
  // spec ({ id, name, par, maybe runtimeVersion }) is small by definition,
  // while a captured upstream spec is a large embedded payload.
  expect(existsSync(path.join(root, 'tests/fixtures'))).toBe(false);
  for (const file of unitTestFiles) {
    const lines = readFileSync(file, 'utf8').split('\n');
    const giant = lines.filter((line) => line.length > 2000);
    expect(
      giant.length,
      `${path.basename(file)} contains a payload-sized line — captured data, not an authored fixture`,
    ).toBe(0);
  }
});

test('the live-catalog coverage stays a separate integration suite', () => {
  // The escape hatch is real: live upstream reads are allowed — in
  // tests/integration, which the unit run never touches.
  const liveCatalog = path.join(root, 'tests/integration/check-live-catalog.mjs');
  expect(existsSync(liveCatalog)).toBe(true);
  const integrationFiles = readdirSync(path.join(root, 'tests/integration'));
  expect(integrationFiles.length).toBeGreaterThan(10);
  // And the unit runner must not pick them up by accident.
  expect(integrationFiles.every((name) => !name.endsWith('.test.js'))).toBe(true);
});
