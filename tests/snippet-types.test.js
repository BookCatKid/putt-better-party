import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Type-checking the snippet-embedded client files.
 *
 * Ten of the thirteen authored client files are spliced by `patch-client.py` into
 * the pinned bundles' own lexical scope, so they are not modules: they see names
 * like `transportPartyStore` and `bpConnection` that no file of theirs declares.
 * That is why they could not be type-checked at all, and why `scripts/
 * client-globals.d.ts` exists - it declares those injected names so `checkJs` can
 * check the transport without pretending they are imports.
 *
 * These tests pin the arrangement from the outside. They run the real compiler
 * because the claim being made is about the compiler, not about our own logic.
 */

const root = path.resolve(import.meta.dir, '..');

/** Run a TypeScript project and return its diagnostics. */
function typecheck(project) {
  const result = spawnSync('bunx', ['tsc', '-p', project], {
    cwd: root,
    encoding: 'utf8',
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test('the snippet project type-checks the transport with no errors', () => {
  const { status, output } = typecheck('tsconfig.snippets.json');
  expect(output).not.toContain('error TS');
  expect(status).toBe(0);
}, 120_000);

test('the standalone-script project type-checks with no errors', () => {
  const { status, output } = typecheck('tsconfig.scripts.json');
  expect(output).not.toContain('error TS');
  expect(status).toBe(0);
}, 120_000);

test('the snippet project actually checks the transport, not just its types', () => {
  // A missing declaration would make every bundle reference an error, and an
  // empty include list would make the project vacuous. Both are caught by asking
  // the compiler what it read.
  const { output } = typecheck('tsconfig.snippets.json');
  expect(output).not.toContain('Cannot find name');
  const config = JSON.parse(
    require('node:fs').readFileSync(path.join(root, 'tsconfig.snippets.json'), 'utf8'),
  );
  expect(config.compilerOptions.checkJs).toBe(true);
  expect(config.compilerOptions.strict).toBe(true);
  expect(config.include).toContain('scripts/party-transport.js');
  expect(config.include).toContain('scripts/client-globals.d.ts');
}, 120_000);

test('the injected globals are declared rather than imported', () => {
  // If these became imports the bundles would need module resolution at runtime,
  // which they do not have: the code is spliced, not loaded.
  const declarations = require('node:fs').readFileSync(
    path.join(root, 'scripts/client-globals.d.ts'),
    'utf8',
  );
  expect(declarations).not.toMatch(/^\s*import\s/m);
  expect(declarations).not.toMatch(/^\s*export\s/m);
  // Each name the transport resolves must be declared somewhere in the file,
  // either as a const or a function.
  for (const name of ['transportPartyStore', 'bpConnection', 'registerTransportSender']) {
    const declared = new RegExp(`declare (?:const|function) ${name}\\b`);
    expect(declarations).toMatch(declared);
  }
});

test('the transport keeps the wire names the bundle depends on', () => {
  // The JSDoc annotations added for checking must not have renamed anything on the
  // wire. These are the compatibility contract, so assert them by name.
  const transport = require('node:fs').readFileSync(
    path.join(root, 'scripts/party-transport.js'),
    'utf8',
  );
  for (const wireName of ["t: 'scene'", "t: 'prog'", "'forfeit'", 'f: 1', "t: 'join'"]) {
    expect(transport).toContain(wireName);
  }
  // And the transport must not have acquired an import it cannot resolve.
  expect(transport).not.toMatch(/^\s*import\s/m);
});
