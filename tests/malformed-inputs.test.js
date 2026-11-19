import { describe, expect, test } from 'bun:test';
import { dispatchSocketMessage } from '../src/socket-dispatch.ts';
import { Room } from '../src/room.ts';
import { isRoomCode } from '../src/request-guards.js';

/**
 * Malformed inputs across every boundary the service exposes.
 *
 * Some surfaces are already pinned elsewhere — HTTP body JSON/size/escapes in
 * request-guards.test.js, checkpoint corruption in persistence.test.js, join
 * refusal codes in join-errors.test.js, the frame budget in abuse.test.js and
 * non-finite coordinates in room.test.js. This file owns the WebSocket wire
 * boundary itself: bytes → JSON → room.handle, where "unparseable" and
 * "handler threw" must answer `bad-message` rather than kill the socket.
 */

function fakeSocket(room) {
  const frames = [];
  const errors = [];
  return {
    data: { room, uid: null },
    frames,
    errors,
    send(serialized) {
      frames.push(JSON.parse(serialized));
    },
    close() {
      this.closed = true;
    },
  };
}

function fakeRoom() {
  const calls = [];
  const errors = [];
  return {
    calls,
    errors,
    handle(ws, message) {
      calls.push(message);
    },
    error(ws, code, message) {
      errors.push({ code, message });
      ws.send(JSON.stringify({ t: 'error', code, msg: message }));
    },
  };
}

describe('the WebSocket wire boundary', () => {
  test('unparseable bytes earn a bad-message error, not a closed socket', () => {
    const room = fakeRoom();
    const ws = fakeSocket(room);
    dispatchSocketMessage(ws, 'this is not json {');
    expect(room.calls).toHaveLength(0);
    expect(room.errors).toEqual([{ code: 'bad-message', message: 'Invalid message' }]);
    expect(ws.closed).toBeUndefined();
  });

  test('truncated and binary garbage fail the same way', () => {
    const room = fakeRoom();
    const ws = fakeSocket(room);
    dispatchSocketMessage(ws, '{"t":"join"');
    dispatchSocketMessage(ws, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    expect(room.calls).toHaveLength(0);
    expect(room.errors).toHaveLength(2);
    expect(room.errors.every((entry) => entry.code === 'bad-message')).toBe(true);
  });

  test('a throwing handler also answers bad-message and keeps the socket', () => {
    const room = fakeRoom();
    room.handle = () => {
      throw new Error('synthetic handler fault');
    };
    const ws = fakeSocket(room);
    dispatchSocketMessage(ws, '{"t":"start"}');
    expect(room.errors).toEqual([{ code: 'bad-message', message: 'Invalid message' }]);
    expect(ws.closed).toBeUndefined();
  });

  test('valid JSON reaches the room verbatim, whatever the shape', () => {
    const room = fakeRoom();
    const ws = fakeSocket(room);
    dispatchSocketMessage(ws, '[1,2,3]');
    dispatchSocketMessage(ws, '"a string is valid json too"');
    dispatchSocketMessage(ws, '42');
    // Shape validation is the room's job (non-records are dropped there);
    // dispatch's job is only that parseable input arrives unmodified.
    expect(room.calls).toEqual([[1, 2, 3], 'a string is valid json too', 42]);
    expect(room.errors).toHaveLength(0);
  });

  test('an unknown frame type is ignored by the room, not answered', () => {
    const room = new Room('ABCDE', new Map());
    // A real joined player: the frame must pass identity and budget checks and
    // then be ignored by the switch — anything less would not prove the point.
    const identity = room.issue('Ghost');
    const ws = fakeSocket(room);
    room.handle(ws, { t: 'join', ...identity, protocol: 2 });
    ws.frames.length = 0;
    dispatchSocketMessage(ws, '{"t":"frame-that-never-existed","x":1}');
    // Ignored frames must not be acknowledged: answering would tell a probing
    // client the frame parsed, and every reply is a cost.
    expect(ws.frames).toHaveLength(0);
    room.dispose();
  });
});

describe('malformed identifiers at the boundaries', () => {
  test('room codes and course ids reject traversal and URL junk', () => {
    for (const bad of ['../../etc', 'ABC DE', 'AAAAA ', '', 'abc1e', 'AAAAA\x00']) {
      expect(isRoomCode(bad)).toBe(false);
    }
    // Room codes live in the URL path; a percent-encoded escape is decoded by
    // containedAssetPath's guard, and these are refused by the code shape too.
    for (const bad of ['%41%42CDE', 'ABCDE.json']) {
      expect(isRoomCode(bad)).toBe(false);
    }
  });
});
