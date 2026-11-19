/**
 * When an idle room may be thrown away.
 *
 * This is deliberately a pure decision over two facts rather than a method on
 * `Room`: the sweep runs on a timer in the server, and a rule that lives inside
 * a `setInterval` callback cannot be exercised without starting a server and
 * waiting thirty minutes. The rule is the part worth reviewing, so it is separated
 * from the loop that applies it.
 */

/**
 * How long a room with nobody connected is kept before it is reclaimed.
 *
 * Generous on purpose: a disconnected player is expected to come back, and their
 * issued credential lives in the room, so reclaiming early would turn a temporary
 * outage into a permanent loss of their identity and score. Thirty minutes is
 * long enough to survive a router restart and short enough to bound memory.
 */
export const ROOM_IDLE_LIMIT_MS = 30 * 60_000;

/** The only two facts the decision needs. */
export interface RoomLiveness {
  /** Players holding a live socket right now, connected or not. */
  connectedPlayers: number;
  /** When the room last saw activity; set at creation, so a never-joined room ages too. */
  lastActivity: number;
}

/**
 * True when the room is empty *and* has been quiet past the limit.
 *
 * Both conditions matter. A live socket always protects the room, even one that
 * has been idle for hours, because the person is still there. And a room that was
 * never joined has no players at all, so it ages out on `lastActivity` alone -
 * otherwise every abandoned "create party" click would leak a room for the life of
 * the process.
 */
export function isReclaimable(room: RoomLiveness, now: number): boolean {
  if (room.connectedPlayers > 0) {
    return false;
  }
  return now - room.lastActivity > ROOM_IDLE_LIMIT_MS;
}
