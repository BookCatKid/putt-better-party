import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  CLIENT_FRAME_TAG_LIST,
  CLIENT_UNTAGGED_FRAME_KINDS,
  SERVER_FRAME_TAG_LIST,
  TERMINAL_ERROR_CODES,
  isTerminalErrorCode,
} from '../src/protocol.js';

/**
 * The wire protocol contract.
 *
 * `src/protocol.ts` declares the frames as discriminated unions, but a union that
 * nothing compares to reality is documentation that can quietly fall out of date.
 * These tests compare the declared contract against the two things that actually
 * speak the protocol - the server's `src/room.ts` and the client's
 * `scripts/party-transport.js` - so a frame added on one side and forgotten on the
 * other fails here instead of being silently dropped in a live party.
 *
 * The comparisons read source text rather than importing the modules, because the
 * client transport runs against browser globals and the point is to check what the
 * code says it sends, not to exercise it.
 */

const root = path.resolve(import.meta.dir, '..');
const serverSource = readFileSync(path.join(root, 'src/room.ts'), 'utf8');
const transportSource = readFileSync(path.join(root, 'scripts/party-transport.js'), 'utf8');
const runtimeSource = readFileSync(path.join(root, 'scripts/party-runtime.js'), 'utf8');

/** The `t` values the server switches on for inbound client frames. */
function serverInboundTags() {
  const tags = new Set();
  const pattern = /case '([a-z][a-z-]*)':/g;
  for (const match of serverSource.matchAll(pattern)) {
    tags.add(match[1]);
  }
  return tags;
}

/** The `t` values the client transport switches on for inbound server frames. */
function clientInboundTags() {
  const tags = new Set();
  const pattern = /case '([a-z][a-z-]*)':/g;
  for (const match of transportSource.matchAll(pattern)) {
    tags.add(match[1]);
  }
  return tags;
}

/** Every `t: '...'` literal the server builds, i.e. the frames it can emit. */
function serverEmittedTags() {
  const tags = new Set();
  const pattern = /\bt: '([a-z][a-z-]*)'/g;
  for (const match of serverSource.matchAll(pattern)) {
    tags.add(match[1]);
  }
  return tags;
}

test('the declared server frames cover every frame the server can emit', () => {
  const declared = new Set(SERVER_FRAME_TAG_LIST);
  const emitted = serverEmittedTags();
  expect(emitted.size).toBeGreaterThan(10);
  // Every emitted frame must be declared, or the contract is incomplete.
  expect([...emitted].filter((tag) => !declared.has(tag))).toEqual([]);
  // And every declared frame must be emitted somewhere, or it is dead weight.
  expect([...declared].filter((tag) => !emitted.has(tag))).toEqual([]);
});

test('the client handles every declared server frame', () => {
  const declared = new Set(SERVER_FRAME_TAG_LIST);
  const handled = clientInboundTags();
  // `pong` has no `case`: the transport resets its unanswered-heartbeat counter
  // on any frame at all before it switches, so the pong is consumed there and
  // must not also get a branch. Asserting the reason keeps a future reader from
  // "fixing" the asymmetry by adding one.
  const handledElsewhere = new Set(['pong']);
  expect([...declared].filter((tag) => !handled.has(tag) && !handledElsewhere.has(tag))).toEqual(
    [],
  );
  expect(handledElsewhere.size).toBe(1);
});

test('the declared client frames cover every frame the server accepts', () => {
  const declared = new Set(CLIENT_FRAME_TAG_LIST);
  const accepted = serverInboundTags();
  // `join` is handled before the authenticated switch, so it is declared but is
  // not one of the cases there.
  const missing = [...accepted].filter((tag) => !declared.has(tag));
  expect(missing).toEqual([]);
  expect(declared.has('join')).toBe(true);
});

test('the client only sends frames the server accepts', () => {
  const sent = new Set();
  const pattern = /\bt: '([a-z][a-z-]*)'/g;
  for (const source of [transportSource, runtimeSource]) {
    for (const match of source.matchAll(pattern)) {
      sent.add(match[1]);
    }
  }
  expect(sent.size).toBeGreaterThan(5);
  const declared = new Set(CLIENT_FRAME_TAG_LIST);
  expect([...sent].filter((tag) => !declared.has(tag))).toEqual([]);
  const accepted = new Set([...serverInboundTags(), 'join']);
  expect([...sent].filter((tag) => !accepted.has(tag))).toEqual([]);
});

test('the untagged completion frame is the one the transport actually writes', () => {
  // The original bundle writes `f: 1` with no `t`, and the server branches on
  // `message.f === 1`. Recording it as an untagged kind keeps that quirk visible.
  expect(CLIENT_UNTAGGED_FRAME_KINDS).toContain('f');
  expect(transportSource).toMatch(/send\(\{\s*f: 1,/);
  expect(serverSource).toContain('message.f === 1');
});

test('the untagged position frame carries the keys the server validates', () => {
  // The transport writes the coordinate object straight to the socket, so the
  // server identifies it by its own keys rather than a tag.
  for (const key of ['px', 'pz']) {
    expect(transportSource).toMatch(new RegExp(`\\b${key}:`));
    expect(serverSource).toContain(`message.${key}`);
  }
  expect(CLIENT_UNTAGGED_FRAME_KINDS).toContain('position');
});

test('only the two documented error codes are treated as terminal', () => {
  // A non-terminal error still allows a reconnect, so widening this set would
  // strand players on a recoverable failure.
  expect([...TERMINAL_ERROR_CODES].sort()).toEqual(['full', 'invalid-join']);
  for (const code of TERMINAL_ERROR_CODES) {
    expect(isTerminalErrorCode(code)).toBe(true);
  }
  for (const code of ['not-host', 'empty-playlist', 'starting', '']) {
    expect(isTerminalErrorCode(code)).toBe(false);
  }
});

test('the terminal codes are a subset of what the server can actually send', () => {
  const emitted = new Set();
  const pattern = /this\.error\(ws, '([a-z-]*)'/g;
  for (const match of serverSource.matchAll(pattern)) {
    emitted.add(match[1]);
  }
  expect(emitted.size).toBeGreaterThan(4);
  for (const code of TERMINAL_ERROR_CODES) {
    expect(emitted.has(code)).toBe(true);
  }
});
