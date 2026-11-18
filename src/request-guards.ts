import path from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { isRecord } from './domain.js';

/**
 * Boundary guards for the HTTP surface. Each function answers one question
 * about a value that arrived from outside this process, so `server.ts` can
 * reject it before it reaches a handler, a filesystem path or an upstream call.
 */

/**
 * A request body is buffered before its shape can be checked, so the limit is
 * applied to the bytes that were actually read rather than only to a declared
 * `content-length` (a chunked request carries none). The server also sets
 * `maxRequestBodySize` to the same value, so Bun refuses an oversized body
 * before it is buffered at all.
 */
export const MAX_JSON_BODY_BYTES = 1_000_000;

/**
 * A payload relayed from upstream (a catalog page, a course metadata object) is
 * re-serialised before it leaves this process. Upstream field lengths are not
 * ours to bound, so a relayed response is limited instead of trusted.
 */
export const MAX_RELAYED_RESPONSE_BYTES = 2_000_000;

/**
 * How many courses one playlist import may name. Each id costs a rate-limited
 * upstream fetch, so a very long list would hold one request open for minutes
 * on the shared upstream queue. The client's own saved playlists hold tens of
 * courses, so this bound only rejects what no legitimate playlist reaches.
 */
export const MAX_PLAYLIST_COURSES = 100;

/**
 * Upstream's public identifier for a course. It is used as a catalog key and as
 * a path segment of preview URLs, so it is constrained to characters that mean
 * nothing to a filesystem or a URL parser: no separators, no dots, no escapes.
 * Five characters is the shortest id observed in the live catalog.
 */
const PUBLIC_COURSE_ID = /^[a-zA-Z0-9_-]{5,64}$/;

/**
 * A party code. It is generated from `A-Z2-9` and appears in page paths and the
 * WebSocket path, so anything else names no room.
 */
const ROOM_CODE = /^[A-Z2-9]{5}$/;

/**
 * A payload that exceeded its size limit. The status travels with the error so
 * the handler can tell the caller's fault (413) from an upstream fault (502).
 */
export class SizeLimitExceededError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SizeLimitExceededError';
  }
}

export function isPublicCourseId(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_COURSE_ID.test(value);
}

export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && ROOM_CODE.test(value);
}

/**
 * The server has no handler for a verb other than these read verbs and POST.
 * Accepting an unexpected write verb is not harmless: `Bun.serve` delivers every
 * verb to the same `fetch`, so a route that only tests the pathname would answer
 * a DELETE exactly like a read.
 */
export function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

/** The only verb the server accepts as a mutation. */
export function isWriteMethod(method: string): boolean {
  return method === 'POST';
}

/**
 * Percent-decode one URL path segment, refusing malformed escapes instead of
 * letting `decodeURIComponent` throw in the middle of route dispatch.
 */
export function decodedPathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Read a JSON request body that must be an object, within the body limit.
 *
 * `content-length` is checked first so an honest oversized body is refused
 * before it is read, then the buffered bytes are measured again because the
 * header can be absent or wrong.
 */
export async function readJsonObject(
  request: Request,
  maximumBytes: number = MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers.get('content-length'));
  if (declaredLength > maximumBytes) {
    throw new SizeLimitExceededError('Request too large', 413);
  }

  const body = await request.text();
  if (Buffer.byteLength(body) > maximumBytes) {
    throw new SizeLimitExceededError('Request too large', 413);
  }

  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('Expected a JSON object');
  }
  if (!isRecord(data)) {
    throw new Error('Expected a JSON object');
  }
  return data;
}

/**
 * Read the ordered ids of a playlist import. Order and repeats are meaningful to
 * the room (a playlist may play the same course twice), so the list is
 * validated element by element and returned as a copy; only picking the courses
 * to fetch deduplicates.
 */
export function parsePublicCourseIdList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1) {
    throw new Error('Invalid saved playlist');
  }
  if (value.length > MAX_PLAYLIST_COURSES) {
    throw new Error('A playlist may hold at most ' + MAX_PLAYLIST_COURSES + ' courses');
  }
  const ids: string[] = [];
  for (const id of value) {
    if (!isPublicCourseId(id)) {
      throw new Error('Invalid saved playlist');
    }
    ids.push(id);
  }
  return ids;
}

/**
 * Refuse a relayed payload larger than the response limit. Upstream answers are
 * parsed at their own boundary, but field lengths are not ours to bound, and a
 * single response is the last place the size can still be enforced.
 */
export function assertResponseWithinLimit(
  data: unknown,
  maximumBytes: number = MAX_RELAYED_RESPONSE_BYTES,
): void {
  if (Buffer.byteLength(JSON.stringify(data)) > maximumBytes) {
    throw new SizeLimitExceededError('Upstream response too large', 502);
  }
}

/**
 * Resolve a request path to a file inside `assetRoot`, or `null` when it does
 * not name one.
 *
 * Containment is decided with `path.relative`, not a string prefix, so a sibling
 * directory that merely shares the root's prefix cannot satisfy it (a root
 * ending in `/assets` must not accept `/assets-evil/secret`). The resolved path
 * is then followed through symlinks, because a link placed inside the root would
 * otherwise serve a file outside it. Only regular files are served, so a
 * directory can never be handed to `Bun.file`.
 */
export function containedAssetPath(assetRoot: string, requestPathname: string): string | null {
  const decoded = decodedPathSegment(requestPathname);
  if (decoded === null || decoded.includes('\0')) {
    return null;
  }

  try {
    const realRoot = realpathSync(assetRoot);
    const candidate = path.resolve(realRoot, '.' + decoded);
    if (!isInsideDirectory(realRoot, candidate)) {
      return null;
    }
    const real = realpathSync(candidate);
    if (!isInsideDirectory(realRoot, real)) {
      return null;
    }
    return statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Separator-aware containment test. Exported because the sibling-prefix case
 * (a root of `/srv/assets` must not accept `/srv/assets-evil`) is the classic
 * `startsWith` bug and deserves to be pinned directly.
 */
export function isInsideDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  if (relative === '' || relative === '..' || path.isAbsolute(relative)) {
    return false;
  }
  return !relative.startsWith('..' + path.sep);
}
