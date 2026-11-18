import { test, expect } from 'bun:test';
import { Room } from '../src/room.js';
import { PacedRequestQueue } from '../src/upstream/request-queue.js';

/**
 * Abuse prevention. The service is anonymous and publicly reachable, so the
 * bounds below are what stop one client from spending the room's CPU or the
 * shared upstream's budget. Each one is sized well above real play, so the
 * interesting assertions are that a correct client is never affected and that a
 * flooding one is stopped.
 */
const spec = { id: 'public-level', name: 'Example', par: 3 };
const maps = new Map([['p', { id: 'p', spec }]]);
const socket = () => ({
  data: {},
  frames: [],
  send(serializedMessage) {
    this.frames.push(JSON.parse(serializedMessage));
  },
  close() {
    this.closed = true;
  },
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForRoom(condition, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Room did not reach the expected state');
    }
    await delay(5);
  }
}
function playableRoom() {
  const room = new Room('ABCDE', maps, { countdown: 5, results: 5 });
  const hostIdentity = room.issue('Host');
  const hostWs = socket();
  room.handle(hostWs, {
    t: 'join',
    ...hostIdentity,
    protocol: 2,
    host: room.hostToken,
    instance: 'host',
  });
  return { room, hostWs, hostIdentity };
}

test('one socket cannot make the server fan out a board for every frame it sends', async () => {
  const { room, hostWs } = playableRoom();
  const guestIdentity = room.issue('Guest');
  const guestWs = socket();
  room.handle(guestWs, { t: 'join', ...guestIdentity, protocol: 2, instance: 'guest' });
  room.handle(hostWs, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['p'], elimination: false },
  });
  room.handle(hostWs, { t: 'start' });
  await waitForRoom(() => room.phase === 'playing');

  // A repeated report of the same count is a no-op rather than a broadcast, so
  // it costs nothing no matter how often it arrives.
  const before = guestWs.frames.filter((frame) => frame.t === 'board').length;
  for (let index = 0; index < 500; index++) {
    room.handle(guestWs, { t: 'prog', st: 0 });
  }
  const afterRepeat = guestWs.frames.filter((frame) => frame.t === 'board').length;
  expect(afterRepeat).toBe(before);

  // Alternating counts are genuine changes, but they still cost a broadcast each,
  // so the dedicated bucket bounds them however fast they arrive.
  for (let index = 0; index < 500; index++) {
    room.handle(guestWs, { t: 'prog', st: index % 2 === 0 ? 1 : 2 });
  }
  const fanOuts = guestWs.frames.filter((frame) => frame.t === 'board').length - afterRepeat;
  // Ten in the burst, plus whatever refilled during the loop's few milliseconds.
  expect(fanOuts).toBeLessThan(40);
  room.dispose();
});

test('a connection that exhausts its frame budget is dropped, not answered', async () => {
  const { room, hostWs, hostIdentity } = playableRoom();
  const hostFramesBefore = hostWs.frames.length;
  // Well past the burst, in one synchronous batch so no time passes to refill.
  for (let index = 0; index < 400; index++) {
    room.handle(hostWs, { t: 'ping' });
  }
  // The client is still joined: a budget stops the frames, it does not evict.
  expect(room.players.get(hostIdentity.uid)?.ws).toBe(hostWs);
  const pongs = hostWs.frames.filter((frame) => frame.t === 'pong').length;
  expect(pongs).toBeGreaterThan(0);
  // Every refused frame was silent, so the flood got no answer to amplify.
  expect(hostWs.frames.length - hostFramesBefore).toBeLessThanOrEqual(130);
  room.dispose();
});

test('the budget refills, so a correct client is never affected', async () => {
  const { room, hostWs, hostIdentity } = playableRoom();
  // Spend most of the burst on heartbeats, then wait for a refill.
  for (let index = 0; index < 100; index++) {
    room.handle(hostWs, { t: 'ping' });
  }
  const player = room.players.get(hostIdentity.uid);
  expect(player?.messageBudget.tokens).toBeLessThan(30);
  await delay(1100);
  room.handle(hostWs, { t: 'ping' });
  // A second of play at sixty frames refills the bucket back towards its burst.
  expect(player?.messageBudget.tokens).toBeGreaterThan(40);
  room.dispose();
});

test('a frame that cannot be admitted upstream is refused rather than queued forever', async () => {
  // The bound that matters is on waiting, not on running: a caller holding the
  // only slot while more than the waiting limit pile up must be told no.
  const queue = new PacedRequestQueue(1, 5, 2);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const first = queue.run(async () => {
    await held;
    return 'first';
  });
  const waiting = [queue.run(async () => 'second'), queue.run(async () => 'third')];
  let refusal;
  try {
    await queue.run(async () => 'overflow');
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(Error);
  expect(refusal.message).toContain('waiting');
  expect(queue.waiting).toBeLessThanOrEqual(2);
  release();
  await first;
  await Promise.allSettled(waiting);
  // Once it has drained, the queue admits work again.
  expect(await queue.run(async () => 'later')).toBe('later');
});
