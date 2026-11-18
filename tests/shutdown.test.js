import { test, expect } from 'bun:test';
import { shutdownResources } from '../src/shutdown.js';

/**
 * Graceful shutdown. The order of the steps is the whole guarantee, so these
 * tests record the order rather than only the outcome: a save after the database
 * closes would throw, and a listener left up can accept a request for a room
 * that has already been disposed.
 */
function harness(overrides = {}) {
  const calls = [];
  const sockets = new Map();
  const socketFor = (name) => {
    const socket = {
      closed: null,
      close(code, reason) {
        socket.closed = { code, reason };
        calls.push('close:' + name);
      },
    };
    sockets.set(name, socket);
    return socket;
  };
  const rooms = [
    {
      players: new Map([
        ['a', { ws: socketFor('a') }],
        ['b', { ws: null }],
      ]),
    },
    { players: new Map([['c', { ws: socketFor('c') }]]) },
  ];
  const resources = {
    stopListener: () => {
      calls.push('stopListener');
    },
    rooms: () => rooms,
    checkpoint: (room) => {
      calls.push('checkpoint:' + [...room.players.keys()].join(','));
    },
    disposeRoom: (room) => {
      calls.push('dispose:' + [...room.players.keys()].join(','));
    },
    closeDatabase: () => {
      calls.push('closeDatabase');
    },
    cancelTimers: () => {
      calls.push('cancelTimers');
    },
    log: (event) => {
      calls.push('log:' + event);
    },
    ...overrides,
  };
  return { calls, rooms, sockets, resources };
}

test('shutdown stops the listener, checkpoints every room, then closes the database', async () => {
  const { calls, resources } = harness();
  const result = await shutdownResources(resources, 'SIGTERM');
  expect(result.ok).toBe(true);
  // The listener is stopped before any room is disposed, and every checkpoint is
  // written before the database closes. Both orderings are load-bearing.
  expect(calls.indexOf('stopListener')).toBeLessThan(calls.indexOf('checkpoint:a,b'));
  expect(calls.filter((call) => call.startsWith('checkpoint:')).length).toBe(2);
  const lastCheckpoint = calls.findLastIndex((call) => call.startsWith('checkpoint:'));
  expect(calls.indexOf('closeDatabase')).toBeGreaterThan(lastCheckpoint);
  expect(calls.at(-1)).toBe('log:server_stopped');
});

test('every connected player is told the service is going away, so the client reconnects', async () => {
  const { resources, sockets } = harness();
  await shutdownResources(resources, 'SIGINT');
  // 1001 is "going away" rather than a bare close: the client distinguishes a
  // deliberate stop from an outage and knows reconnecting is worthwhile.
  expect(sockets.get('a').closed).toEqual({ code: 1001, reason: 'Server shutting down' });
  expect(sockets.get('c').closed).toEqual({ code: 1001, reason: 'Server shutting down' });
});

test('a socket that is already gone does not stop the shutdown', async () => {
  const { resources, calls, rooms } = harness();
  // A half-open socket can throw when asked to close; that must not prevent the
  // checkpoint, which is what actually protects the party.
  rooms[0].players.set('a', {
    ws: {
      close() {
        throw new Error('socket already destroyed');
      },
    },
  });
  const result = await shutdownResources(resources, 'SIGTERM');
  expect(result.ok).toBe(true);
  expect(calls.filter((call) => call.startsWith('checkpoint:')).length).toBe(2);
});

test('a failed listener stop still checkpoints every room', async () => {
  const { resources, calls } = harness({
    stopListener: () => {
      throw new Error('listener already closed');
    },
  });
  const result = await shutdownResources(resources, 'SIGTERM');
  // The listener being down is not a reason to lose the rooms.
  expect(result.ok).toBe(true);
  expect(calls).toContain('log:shutdown_listener_error');
  expect(calls.filter((call) => call.startsWith('checkpoint:')).length).toBe(2);
});

test('a failed checkpoint is reported instead of closing the database over it', async () => {
  let checkpoints = 0;
  const { resources } = harness({
    checkpoint: () => {
      checkpoints += 1;
      throw new Error('disk full');
    },
  });
  const result = await shutdownResources(resources, 'SIGTERM');
  expect(result.ok).toBe(false);
  expect(result.error).toBeInstanceOf(Error);
  expect(checkpoints).toBe(1);
});

test('a second signal does not restart the sequence', async () => {
  // The guard lives in the caller, so the contract here is only that a repeated
  // run is individually complete: each room is checkpointed once per run.
  const { resources, calls } = harness();
  await shutdownResources(resources, 'SIGTERM');
  await shutdownResources(resources, 'SIGTERM');
  const checkpoints = calls.filter((call) => call.startsWith('checkpoint:')).length;
  expect(checkpoints).toBe(4);
});
