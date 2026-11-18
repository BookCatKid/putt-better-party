import { test, expect } from 'bun:test';
import { Room } from '../src/room.js';

/**
 * Resource efficiency.
 *
 * The cost that matters is not one `JSON.stringify`; it is how that cost scales
 * with the size of a party. A course specification is the whole level geometry
 * and is by far the largest thing this service sends, so any work done per
 * player per frame multiplies the biggest field by the number of players. These
 * tests therefore count work rather than time: timing assertions are flaky on a
 * shared machine, while "how many times was this serialized" is exact.
 */

/** A socket that records the raw strings it was handed, not parsed frames. */
const rawSocket = () => ({
  data: {},
  raw: [],
  send(serialized) {
    this.raw.push(serialized);
  },
  close() {},
});

/** A level large enough that per-socket serialization is obvious if it happens. */
function largeSpecification(id) {
  return {
    id,
    name: 'Course ' + id,
    par: 3,
    geometry: {
      vertices: Array.from({ length: 500 }, (ignored, index) => ({ x: index, y: index * 2, z: 3 })),
      faces: Array.from({ length: 500 }, (ignored, index) => [index, index + 1, index + 2]),
    },
  };
}

const ids = Array.from({ length: 4 }, (ignored, index) => 'course-' + index);
const maps = new Map(ids.map((id) => [id, { id, spec: largeSpecification(id) }]));

/** A room with `count` joined players, each holding a raw socket. */
function partyWith(count) {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  room.holeIds = ids;
  room.specs = ids.map((id) => maps.get(id).spec);
  const sockets = [];
  for (let index = 0; index < count; index++) {
    const identity = room.issue('Player ' + index);
    const ws = rawSocket();
    sockets.push(ws);
    room.players.set(identity.uid, {
      uid: identity.uid,
      name: identity.name,
      hue: identity.hue,
      id: 'player-' + index,
      ws,
      role: 'player',
      ready: true,
      alive: true,
      participated: true,
      holesSurvived: 0,
      totalStrokes: 0,
      strokes: 0,
      done: false,
      messageBudget: { tokens: 120, updatedAt: Date.now() },
      boardBudget: { tokens: 10, updatedAt: Date.now() },
    });
  }
  return { room, sockets };
}

test('one broadcast serializes the frame once, however many players receive it', () => {
  const { room, sockets } = partyWith(20);
  // Count serializations rather than compare output: a per-socket `stringify`
  // produces byte-identical frames, so only the count of calls can tell the two
  // implementations apart.
  let serializations = 0;
  const original = JSON.stringify;
  JSON.stringify = (value, ...rest) => {
    serializations += 1;
    return original(value, ...rest);
  };
  try {
    room.broadcast(room.snapshot());
  } finally {
    JSON.stringify = original;
  }
  // The snapshot is built before the call, so exactly one serialization happens
  // for all twenty recipients.
  expect(serializations).toBe(1);
  expect(sockets.every((ws) => ws.raw.length === 1)).toBe(true);
  // Every socket received the same bytes.
  expect(sockets.every((ws) => ws.raw[0] === sockets[0].raw[0])).toBe(true);
  room.dispose();
});

test('a serialized broadcast carries the whole snapshot, including the map', () => {
  const { room, sockets } = partyWith(2);
  room.broadcast(room.snapshot());
  const snapshot = JSON.parse(sockets[0].raw[0]);
  // The client replaces its state with each snapshot rather than merging, so
  // the map has to travel every time; a performance change must not drop it.
  expect(snapshot.t).toBe('party');
  expect(snapshot.currentMap.id).toBe(ids[0]);
  expect(snapshot.currentMap.geometry.vertices).toHaveLength(500);
  expect(snapshot.holeIds).toEqual(ids);
  room.dispose();
});

test('a broken socket does not stop the rest of the party receiving a frame', () => {
  const { room, sockets } = partyWith(3);
  // One socket throws when written to, as a socket closing mid-write does.
  const broken = [...room.players.values()][1];
  broken.ws = {
    data: {},
    send() {
      throw new Error('socket closed mid-write');
    },
    close() {},
  };
  room.broadcast(room.snapshot());
  expect(sockets[0].raw).toHaveLength(1);
  expect(sockets[2].raw).toHaveLength(1);
  room.dispose();
});

test('a frame that cannot be serialized is dropped once, not per player', () => {
  const { room, sockets } = partyWith(3);
  const circular = { t: 'party' };
  circular.self = circular;
  // The room's types never allow this; the test proves the guard does not turn
  // one bad frame into twenty failed sends.
  room.broadcast(circular);
  expect(sockets.every((ws) => ws.raw.length === 0)).toBe(true);
  room.dispose();
});

test('an empty party does no serialization work at all', () => {
  const { room } = partyWith(0);
  // Nothing is connected, so the frame is never stringified. The assertion is
  // one of absence: `broadcast` returns before touching the payload.
  let serializations = 0;
  const original = JSON.stringify;
  JSON.stringify = (value, ...rest) => {
    serializations += 1;
    return original(value, ...rest);
  };
  try {
    room.broadcast(room.snapshot());
  } finally {
    JSON.stringify = original;
  }
  expect(serializations).toBe(0);
  room.dispose();
});
