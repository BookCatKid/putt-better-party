import { test, expect } from 'bun:test';
import { isReclaimable, ROOM_IDLE_LIMIT_MS } from '../src/room-expiry.js';

const at = (idleMs, connectedPlayers = 0) => ({
  connectedPlayers,
  lastActivity: 1_000_000 - idleMs,
});

test('a live socket always protects the room, however long it has been quiet', () => {
  // Someone is still sitting in the lobby with the tab open. Reclaiming their
  // room would destroy a credential they are actively using.
  expect(isReclaimable(at(ROOM_IDLE_LIMIT_MS * 10, 1), 1_000_000)).toBe(false);
  expect(isReclaimable(at(ROOM_IDLE_LIMIT_MS * 10, 3), 1_000_000)).toBe(false);
});

test('an empty room ages out once it passes the limit', () => {
  expect(isReclaimable(at(ROOM_IDLE_LIMIT_MS + 1), 1_000_000)).toBe(true);
  expect(isReclaimable(at(ROOM_IDLE_LIMIT_MS), 1_000_000)).toBe(false);
  expect(isReclaimable(at(0), 1_000_000)).toBe(false);
});

test('a room that was created and never joined is reclaimed too', () => {
  // No players at all: the `connectedPlayers` count is zero and `lastActivity` is
  // creation time, so an abandoned "create party" click must not leak forever.
  expect(isReclaimable({ connectedPlayers: 0, lastActivity: 0 }, ROOM_IDLE_LIMIT_MS + 1)).toBe(
    true,
  );
  expect(isReclaimable({ connectedPlayers: 0, lastActivity: 0 }, 0)).toBe(false);
});

test('a player who disconnects protects the room for the grace period, then not', () => {
  // Disconnecting updates `lastActivity`, so a returning player has the full
  // window to come back with the same identity rather than losing it immediately.
  const disconnectedAt = 5_000_000;
  expect(isReclaimable({ connectedPlayers: 0, lastActivity: disconnectedAt }, disconnectedAt)).toBe(
    false,
  );
  expect(
    isReclaimable(
      { connectedPlayers: 0, lastActivity: disconnectedAt },
      disconnectedAt + ROOM_IDLE_LIMIT_MS,
    ),
  ).toBe(false);
  expect(
    isReclaimable(
      { connectedPlayers: 0, lastActivity: disconnectedAt },
      disconnectedAt + ROOM_IDLE_LIMIT_MS + 1,
    ),
  ).toBe(true);
});

test('a reconnect during the grace period cancels the reclaim', () => {
  // The sweep is synchronous, so this is the ordering that matters: if the
  // player's socket is back by the time the sweep looks, the room is protected.
  const idle = { connectedPlayers: 0, lastActivity: 0 };
  const later = ROOM_IDLE_LIMIT_MS + 1;
  expect(isReclaimable(idle, later)).toBe(true);
  expect(isReclaimable({ ...idle, connectedPlayers: 1 }, later)).toBe(false);
});
