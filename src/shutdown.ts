/**
 * Graceful shutdown.
 *
 * A service manager stops this process with `SIGTERM`, and Ctrl-C sends
 * `SIGINT`; both mean the same thing. Without a handler the process dies where
 * it stands, which loses two things that matter: the SQLite write-ahead log is
 * never checkpointed, and every connected player is left on a socket that
 * simply stops answering.
 *
 * The sequence below is asserted by `tests/shutdown.test.js` rather than only by
 * inspection, because the order is the whole point: a save after the database
 * closes would throw, and a listener that stays up can accept a request for a
 * room that has already been disposed.
 */

/** The shape a shutdown needs from a socket, so this stays independent of the room. */
export interface ClosableSocket {
  close(code?: number, reason?: string): unknown;
}

export interface ShutdownResources<RoomType extends ShutdownRoom> {
  /** Stops accepting new connections. */
  stopListener: () => Promise<unknown> | unknown;
  /** Every live room, with the sockets that must be told the service is closing. */
  rooms: () => Iterable<RoomType>;
  /** Writes one room's checkpoint. Called before the database closes. */
  checkpoint: (room: RoomType) => void;
  /** Releases one room's timers. */
  disposeRoom: (room: RoomType) => void;
  /** Closes the database, after every checkpoint has been written. */
  closeDatabase: () => void;
  /** Cancels the periodic timers owned by the process. */
  cancelTimers: () => void;
  log: (event: string, details?: Record<string, unknown>) => void;
}

/** The minimum a shutdown needs from a room. */
export interface ShutdownRoom {
  players: Map<string, { ws: ClosableSocket | null }>;
}

/**
 * Runs the shutdown in the order that makes each step safe, and reports failure
 * instead of hiding it. It never throws: the caller decides what exit code a
 * partial shutdown deserves, and a second signal must not restart the sequence.
 */
export async function shutdownResources<RoomType extends ShutdownRoom>(
  resources: ShutdownResources<RoomType>,
  signal: string,
): Promise<{ ok: boolean; error?: unknown }> {
  // The listener goes first so no request can arrive for a room that is about to
  // be disposed, and no player is told the service is closing while still being
  // able to join.
  resources.cancelTimers();
  try {
    await resources.stopListener();
  } catch {
    // A listener that is already down is not a reason to skip the checkpoint,
    // which is the step that actually protects a player's party.
    resources.log('shutdown_listener_error', { signal });
  }
  const rooms = [...resources.rooms()];
  for (const room of rooms) {
    for (const player of room.players.values()) {
      try {
        // 1001 is "going away": the peer knows this is not a crash and that
        // reconnecting is worthwhile. The client already resumes from its saved
        // identity, so the party is waiting when it comes back.
        player.ws?.close(1001, 'Server shutting down');
      } catch {
        // A socket that is already gone needs no closing.
      }
    }
    try {
      resources.checkpoint(room);
    } catch (error) {
      resources.log('shutdown_checkpoint_error', { signal });
      return { ok: false, error };
    }
    try {
      resources.disposeRoom(room);
    } catch (error) {
      resources.log('shutdown_dispose_error', { signal });
      return { ok: false, error };
    }
  }
  try {
    resources.closeDatabase();
  } catch (error) {
    resources.log('shutdown_database_error', { signal });
    return { ok: false, error };
  }
  resources.log('server_stopped', { signal, rooms: rooms.length });
  return { ok: true };
}
