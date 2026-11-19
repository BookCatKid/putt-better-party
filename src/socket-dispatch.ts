/**
 * The `websocket.message` callback body, extracted so malformed wire input is
 * unit-testable without booting `Bun.serve`.
 *
 * Two distinct failure answers live here by design:
 *
 * - **Unparseable bytes** — `JSON.parse` throws, and the socket earns a
 *   `bad-message` error frame. This is the only place raw input becomes an
 *   object, so "invalid JSON" cannot escape as an exception up the socket
 *   stack.
 * - **A throwing handler** — a room bug on an otherwise valid frame is the
 *   same answer: `bad-message` plus a logged error, and the socket stays
 *   open. Crashing the connection on a bug would let one malformed-looking
 *   frame take an honest player down with it.
 *
 * Size is not handled here: `maxPayloadLength` in the `Bun.serve` config drops
 * oversized messages before this function is ever called.
 */
import type { RoomSocket } from './room-types.js';
import type { Room } from './room.js';
import { errorMessage } from './domain.js';

export function dispatchSocketMessage(
  ws: RoomSocket & { data: { room: Room } },
  raw: { toString(): string },
): void {
  try {
    ws.data.room.handle(ws, JSON.parse(raw.toString()));
  } catch (error) {
    ws.data.room.error(ws, 'bad-message', 'Invalid message');
    console.error(errorMessage(error));
  }
}
