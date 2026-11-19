import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The home page is browser-only code with no unit harness, so these tests pin the
 * properties that would break it silently.
 *
 * Two of them are drift guards between files that must agree: the party-code
 * alphabet is written in both the client and the server, and a mismatch rejects a
 * valid code before it is ever sent - indistinguishable, to the player, from a
 * typo. The rest are structural: they assert that every admission request is
 * bounded and that no storage access can throw before the handlers are attached.
 */

const root = path.resolve(import.meta.dir, '..');
const homeSource = readFileSync(path.join(root, 'scripts/home.ts'), 'utf8');
const guardsSource = readFileSync(path.join(root, 'src/request-guards.ts'), 'utf8');
const serverSource = readFileSync(path.join(root, 'src/server.ts'), 'utf8');

/** The literal of a `const NAME = /.../;` declaration. */
function regexLiteral(source, name) {
  const match = source.match(new RegExp(`const ${name} = (/[^/]+/[a-z]*);`));
  expect(match).not.toBeNull();
  return match[1];
}

test('the client and server agree on the party-code alphabet', () => {
  const client = regexLiteral(homeSource, 'PARTY_CODE');
  const server = regexLiteral(guardsSource, 'ROOM_CODE');
  // Same pattern, so a code the page accepts is a code the server will look up.
  expect(client).toBe(server);
});

test('every generated code is one the client and server accept', () => {
  const generated = serverSource.match(
    /\bcode = Array\.from\(\s*\{ length: 5 \},\s*\(\) => '([^']+)'\[/,
  );
  expect(generated).not.toBeNull();
  const alphabet = generated[1];

  const accepted = regexLiteral(homeSource, 'PARTY_CODE');
  const range = accepted.match(/^\/\^\[(.+)\]\{5\}\$\/$/);
  expect(range).not.toBeNull();

  // `A-Z2-9` is a character class with ranges; expand it so each generated
  // character can be checked against it.
  const allowed = new Set();
  for (const part of range[1].matchAll(/(.)-(.)|(.)/g)) {
    if (part[3]) {
      allowed.add(part[3]);
      continue;
    }
    for (let code = part[1].charCodeAt(0); code <= part[2].charCodeAt(0); code += 1) {
      allowed.add(String.fromCharCode(code));
    }
  }
  for (const character of alphabet) {
    expect(allowed.has(character)).toBe(true);
  }
  // The generator deliberately omits look-alikes, so it is a strict subset.
  expect(alphabet.length).toBeLessThan(allowed.size);
});

test('every admission request is bounded by a timeout', () => {
  const requests = [...homeSource.matchAll(/fetch\(([\s\S]*?)\)\s*[;.]/g)];
  expect(requests.length).toBeGreaterThanOrEqual(3);
  for (const request of requests) {
    // A stalled connection must not leave both controls disabled forever.
    expect(request[1]).toContain('AbortSignal.timeout(REQUEST_TIMEOUT_MS)');
  }
});

test('no storage access can throw before the handlers are attached', () => {
  // A bare `sessionStorage` access at module scope aborts the whole file, leaving
  // a page with no handlers - a dead page with no explanation. Every access must
  // therefore be inside the guarded helpers.
  const helpers = homeSource.slice(
    homeSource.indexOf('function readStored'),
    homeSource.indexOf('function storageWorks'),
  );
  expect(helpers).toContain('sessionStorage.getItem');
  expect(helpers).toContain('sessionStorage.setItem');
  expect(helpers).toContain('sessionStorage.removeItem');

  const outsideHelpers = homeSource
    .replace(helpers, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  expect(outsideHelpers).not.toContain('sessionStorage');
});

test('one admission runs at a time, so create and join cannot race a navigation', () => {
  // Both entry points take the guard, and both release it on failure only.
  expect(homeSource.match(/beginAdmission\(\)/g).length).toBeGreaterThanOrEqual(3);
  expect(homeSource).toContain('if (admissionInFlight) {');
  expect(homeSource).toContain('joinButton.disabled = true');
  expect(homeSource).toContain('createButton.disabled = true');
});
