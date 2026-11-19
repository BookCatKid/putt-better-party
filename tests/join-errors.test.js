import { test, expect } from 'bun:test';
import { Room } from '../src/room.js';
import { JoinRefused, joinRefusalStatus } from '../src/join-errors.js';

const maps = new Map([['p', { id: 'p', spec: { id: 'p', name: 'Example', par: 3 } }]]);

/** The code `issue()` refuses with, or `null` when it issues an identity. */
function refusal(run) {
  try {
    run();
    return null;
  } catch (error) {
    if (!(error instanceof JoinRefused)) {
      throw error;
    }
    return error.code;
  }
}

test('every join refusal carries a code, not just a message', () => {
  const room = new Room('ABCDE', maps);
  try {
    expect(refusal(() => room.issue(''))).toBe('invalid-name');
    expect(refusal(() => room.issue('x'.repeat(25)))).toBe('invalid-name');
    expect(refusal(() => room.issue(42))).toBe('invalid-name');

    // A credential that no longer matches its identity is the one failure with a
    // recovery path, so it has to be distinguishable from "you are not welcome".
    expect(refusal(() => room.issue('Guest', 'unknown-uid', 'stale-session'))).toBe(
      'session-expired',
    );

    const guest = room.issue('Guest');
    room.handle(
      {
        data: {},
        frames: [],
        send() {},
        close() {},
      },
      { t: 'join', ...guest, protocol: 2 },
    );

    // A valid returning identity is never refused, even when the party is full:
    // the capacity check must not lock out the people already inside.
    expect(refusal(() => room.issue('Guest', guest.uid, guest.session))).toBe(null);
  } finally {
    room.dispose();
  }
});

test('policy refusals are distinct from capacity and validation failures', () => {
  const room = new Room('ABCDE', maps);
  try {
    const host = room.issue('Host');
    room.bannedNames.add('rude');
    expect(refusal(() => room.issue('RUDE'))).toBe('banned');

    room.configure(
      { data: { uid: host.uid }, frames: [], send() {}, close() {} },
      { locked: true },
    );
    expect(refusal(() => room.issue('Newcomer'))).toBe('locked');
  } finally {
    room.dispose();
  }

  const crowded = new Room('ABCDE', maps);
  try {
    crowded.configure({ data: {}, frames: [], send() {}, close() {} }, { maxPlayers: 1 });
    crowded.handle(
      { data: {}, frames: [], send() {}, close() {} },
      { t: 'join', ...crowded.issue('First'), protocol: 2 },
    );
    expect(refusal(() => crowded.issue('Second'))).toBe('full');
  } finally {
    crowded.dispose();
  }
});

test('the status a refusal is worth matches its meaning', () => {
  // A presented-but-dead credential is an authentication failure, not a
  // malformed request, and the client shows a different recovery for it.
  expect(joinRefusalStatus('session-expired')).toBe(401);
  expect(joinRefusalStatus('banned')).toBe(403);
  expect(joinRefusalStatus('locked')).toBe(403);
  // Nothing is wrong with the request; the party just cannot take anyone now.
  expect(joinRefusalStatus('full')).toBe(409);
  expect(joinRefusalStatus('identity-limit')).toBe(409);
  expect(joinRefusalStatus('invalid-name')).toBe(400);

  // Every code must be mapped, or a refusal would reach the client as a bare 500.
  const codes = ['invalid-name', 'banned', 'locked', 'session-expired', 'full', 'identity-limit'];
  for (const code of codes) {
    expect(Number.isInteger(joinRefusalStatus(code))).toBe(true);
  }
});
