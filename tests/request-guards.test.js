import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MAX_JSON_BODY_BYTES,
  MAX_PLAYLIST_COURSES,
  SizeLimitExceededError,
  assertResponseWithinLimit,
  containedAssetPath,
  decodedPathSegment,
  isInsideDirectory,
  isPublicCourseId,
  isReadMethod,
  isRoomCode,
  isWriteMethod,
  parsePublicCourseIdList,
  readJsonObject,
} from '../src/request-guards.js';

/**
 * Boundary guards for the HTTP surface. Every helper here answers one question
 * about an untrusted value, so these cases are written as "what an attacker
 * would send" rather than as a description of the implementation.
 */

const jsonRequest = (body, headers = {}) =>
  new Request('http://party.test/api/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });

test('a public course ID admits only the catalog alphabet, so no id can name a path', () => {
  expect(isPublicCourseId('44468fa2c0d94ce1b3b0a1e2f3a4b5c6')).toBe(true);
  expect(isPublicCourseId('mqq4fknuwts5ef')).toBe(true);
  expect(isPublicCourseId('abc_D-9')).toBe(true);

  // Traversal, separators and URL syntax must not survive into an upstream path
  // or a log line, even when the value is percent-decoded first.
  for (const hostile of [
    '../etc/passwd',
    '..',
    '../../../../etc/passwd',
    'a/b',
    'a\\b',
    '.hidden',
    'id with space',
    'id?query=1',
    'id#fragment',
    'id%2f..%2f',
    'id\u0000',
    '',
  ]) {
    expect(isPublicCourseId(hostile)).toBe(false);
  }

  // Length is part of the contract: too short cannot be a real id, and an
  // unbounded id would be relayed upstream and into a log.
  expect(isPublicCourseId('abcd')).toBe(false);
  expect(isPublicCourseId('a'.repeat(64))).toBe(true);
  expect(isPublicCourseId('a'.repeat(65))).toBe(false);
  expect(isPublicCourseId(undefined)).toBe(false);
  expect(isPublicCourseId(42)).toBe(false);
});

test('a party code is exactly the generated alphabet and length', () => {
  expect(isRoomCode('ABCDE')).toBe(true);
  expect(isRoomCode('2ABC9')).toBe(true);
  // Lowercase, ambiguous letters, wrong lengths and path syntax all name no room.
  for (const hostile of [
    'abcde',
    'ABCD1',
    'ABCD',
    'ABCDEF',
    '../AB',
    'ABCDE/x',
    '',
    'ABCD\u0000',
  ]) {
    expect(isRoomCode(hostile)).toBe(false);
  }
  expect(isRoomCode(null)).toBe(false);
});

test('only GET and HEAD are reads and only POST writes', () => {
  expect(isReadMethod('GET')).toBe(true);
  expect(isReadMethod('HEAD')).toBe(true);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'get', '']) {
    expect(isReadMethod(method)).toBe(false);
  }
  expect(isWriteMethod('POST')).toBe(true);
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'post']) {
    expect(isWriteMethod(method)).toBe(false);
  }
});

test('a malformed percent escape is refused instead of throwing mid-dispatch', () => {
  expect(decodedPathSegment('abc%20def')).toBe('abc def');
  expect(decodedPathSegment('plain')).toBe('plain');
  // A lone `%` and a truncated escape make decodeURIComponent throw; route
  // dispatch must get `null` rather than fall into the error handler.
  expect(decodedPathSegment('%')).toBeNull();
  expect(decodedPathSegment('%2')).toBeNull();
  expect(decodedPathSegment('%zz')).toBeNull();
  expect(decodedPathSegment('%E0%A4%A')).toBeNull();
});

test('a correct JSON body is read and an object is returned', async () => {
  const body = await readJsonObject(jsonRequest(JSON.stringify({ code: 'ABCDE', name: 'Host' })));
  expect(body).toEqual({ code: 'ABCDE', name: 'Host' });
});

test('a body over the cap is refused before it is parsed', async () => {
  const oversized = JSON.stringify({ padding: 'x'.repeat(MAX_JSON_BODY_BYTES + 1) });
  await expect(readJsonObject(jsonRequest(oversized))).rejects.toThrow(SizeLimitExceededError);

  // A declared length over the cap is refused without reading the body at all.
  await expect(
    readJsonObject(jsonRequest('{}', { 'content-length': String(MAX_JSON_BODY_BYTES + 1) })),
  ).rejects.toThrow(SizeLimitExceededError);

  // A chunked or forged body carries no trustworthy length, so the bytes that
  // were actually buffered are measured too. This is the case the old
  // content-length-only check let through.
  const unbounded = new Request('http://party.test/api/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(MAX_JSON_BODY_BYTES + 1) }),
  });
  unbounded.headers.delete('content-length');
  await expect(readJsonObject(unbounded)).rejects.toThrow(SizeLimitExceededError);
});

test('a body that is not a JSON object is refused', async () => {
  await expect(readJsonObject(jsonRequest('[1,2,3]'))).rejects.toThrow('Expected a JSON object');
  await expect(readJsonObject(jsonRequest('"text"'))).rejects.toThrow('Expected a JSON object');
  await expect(readJsonObject(jsonRequest('null'))).rejects.toThrow('Expected a JSON object');
  await expect(readJsonObject(jsonRequest('{'))).rejects.toThrow('Expected a JSON object');
});

test('a relayed payload over the response cap is refused', () => {
  expect(() => assertResponseWithinLimit({ holes: [] }, 1024)).not.toThrow();
  expect(() => assertResponseWithinLimit({ padding: 'x'.repeat(2048) }, 1024)).toThrow(
    SizeLimitExceededError,
  );
  // A relayed payload is the upstream's fault, not the caller's, so it reports
  // as a bad gateway rather than a client error.
  try {
    assertResponseWithinLimit({ padding: 'x'.repeat(2048) }, 1024);
  } catch (error) {
    expect(error.status).toBe(502);
  }
});

test('a playlist keeps order and repeats but is bounded and type-checked', () => {
  const ids = ['abcde', 'fghij', 'abcde'];
  expect(parsePublicCourseIdList(ids)).toEqual(ids);

  expect(() => parsePublicCourseIdList([])).toThrow('Invalid saved playlist');
  expect(() => parsePublicCourseIdList('abcde')).toThrow('Invalid saved playlist');
  expect(() => parsePublicCourseIdList(['abcde', '../etc/passwd'])).toThrow(
    'Invalid saved playlist',
  );
  expect(() => parsePublicCourseIdList(['abcde', 42])).toThrow('Invalid saved playlist');
  expect(() => parsePublicCourseIdList(new Array(MAX_PLAYLIST_COURSES + 1).fill('abcde'))).toThrow(
    'A playlist may hold at most',
  );
  // The returned list is a copy, so a caller cannot mutate the parsed result
  // back into the room's configuration.
  const source = ['abcde'];
  const parsed = parsePublicCourseIdList(source);
  parsed.push('fghij');
  expect(source).toEqual(['abcde']);
});

test('directory containment is separator aware, so a sibling prefix is not inside', () => {
  expect(isInsideDirectory('/srv/web', '/srv/web/assets/app.js')).toBe(true);
  expect(isInsideDirectory('/srv/web', '/srv/web')).toBe(false);
  expect(isInsideDirectory('/srv/web', '/srv/web-evil/secret.txt')).toBe(false);
  expect(isInsideDirectory('/srv/web', '/srv/web/../web-evil/secret.txt')).toBe(false);
  expect(isInsideDirectory('/srv/web', '/srv')).toBe(false);
  expect(isInsideDirectory('/srv/web', '/etc/passwd')).toBe(false);
  expect(isInsideDirectory('/srv/web', '/srv/web/../etc/passwd')).toBe(false);
});

test('static asset serving never escapes its root', () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'bp-assets-'));
  const assetRoot = path.join(workspace, 'web');
  mkdirSync(path.join(assetRoot, 'assets'), { recursive: true });
  writeFileSync(path.join(assetRoot, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(path.join(workspace, 'secret.txt'), 'private');
  // A sibling directory whose name merely starts with the root's name. A
  // `startsWith(root + '/')` check would accept `/web-evil` only if the root had
  // no separator, so the case is exercised both through the helper and through
  // the resolved path.
  mkdirSync(path.join(workspace, 'web-evil'), { recursive: true });
  writeFileSync(path.join(workspace, 'web-evil', 'secret.txt'), 'private');
  symlinkSync(path.join(workspace, 'secret.txt'), path.join(assetRoot, 'assets', 'link.txt'));

  try {
    // Escape attempts come first: these are the cases the guard exists for.
    for (const hostile of [
      '/assets/../../secret.txt',
      '/assets/../secret.txt',
      '/../../etc/passwd',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/assets-evil/secret.txt',
      '/../web-evil/secret.txt',
      '/assets/app.js\u0000.txt',
    ]) {
      expect(containedAssetPath(assetRoot, hostile)).toBeNull();
    }

    // A symlink inside the root that points outside it must not be followed:
    // a prepared asset directory is copied from elsewhere, so a link in it is
    // not evidence that the target is servable.
    expect(containedAssetPath(assetRoot, '/assets/link.txt')).toBeNull();
    // A directory is not a file to serve.
    expect(containedAssetPath(assetRoot, '/assets')).toBeNull();
    expect(containedAssetPath(assetRoot, '/assets/')).toBeNull();
    // A malformed escape never reaches the filesystem.
    expect(containedAssetPath(assetRoot, '/assets/%')).toBeNull();

    // A legitimate request still resolves. The returned path is fully resolved,
    // which on macOS means the `/private` prefix of the temporary directory.
    expect(containedAssetPath(assetRoot, '/assets/app.js')).toBe(
      realpathSync(path.join(assetRoot, 'assets', 'app.js')),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
