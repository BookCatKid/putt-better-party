/**
 * Room persistence: the two functions that snapshot a room for the store and
 * rehydrate one after a restart.
 *
 * Persisted state is deliberately narrow — configuration, public course
 * metadata, credentials and history — never specifications, ball positions,
 * sockets or timers. A restored room always lands back in the lobby: a
 * restarted process cannot recover the original client's physics state, so
 * resuming a partially scored round would be a fiction.
 */
import { LATE_JOIN, MAP_SOURCE, MAX_MATCH_HISTORY, defaults, type RoomPhase } from './domain.js';
import type { Room } from './room.js';
import type { RoomCheckpoint } from './room-types.js';

/**
 * Persist only room configuration, public course metadata and credentials.
 * Never serialize course specifications, positions, sockets or timers.
 */
export function buildCheckpoint(room: Room): RoomCheckpoint {
  const titles = Object.fromEntries(
    room.config.selectedHoleIds.map((id) => [id, room.catalog.get(id)?.title ?? id]),
  );
  return {
    version: 1,
    code: room.code,
    hostToken: room.hostToken,
    hostUid: room.hostUid,
    hostTransfer: room.hostTransfer ? { ...room.hostTransfer } : null,
    issued: [...room.issued.values()],
    ...(room.bannedNames.size ? { bannedNames: [...room.bannedNames] } : {}),
    config: structuredClone(room.config),
    titles,
    randomSeen: [...room.randomSeen],
    matchHistory: room.matchHistory.map((match) => ({
      ...match,
      courses: match.courses.map((course) => ({ ...course })),
      standings: match.standings.map((row) => ({ ...row })),
    })),
    tournament: room.tournament
      ? {
          ...room.tournament,
          standings: room.tournament.standings.map((row) => ({ ...row })),
        }
      : null,
    phase: room.phase,
    starting: room.starting,
    lastActivity: room.lastActivity,
    recoveryNotice: room.recoveryNotice,
  };
}

/**
 * What the recovery audit needs to say: the phase the room was in when it was
 * persisted, and whether the restore decided the party must be told it came
 * back from a restart.
 */
export type RestoreOutcome = {
  previousPhase: RoomPhase;
  recoveryNotice: boolean;
};

/** Rehydrate every persisted field; the caller audits the outcome. */
export function restoreRoom(room: Room, data: RoomCheckpoint): RestoreOutcome {
  room.hostToken = data.hostToken;
  room.hostUid = data.hostUid;
  const transfer = data.hostTransfer;
  room.hostTransfer =
    transfer && typeof transfer.toUid === 'string' && typeof transfer.fromUid === 'string'
      ? { fromUid: transfer.fromUid, toUid: transfer.toUid, at: Number(transfer.at) || 0 }
      : null;
  room.issued = new Map(data.issued.map((identity) => [identity.uid, identity]));
  room.bannedNames = new Set(data.bannedNames ?? []);
  room.config = {
    ...defaults,
    ...data.config,
    lateJoin: data.config.lateJoin ?? LATE_JOIN.NEVER,
    randomHoles:
      data.config.randomHoles ??
      (data.config.mapSource === MAP_SOURCE.RANDOM ? data.config.holes : 3),
  };
  room.randomSeen = Array.isArray(data.randomSeen) ? data.randomSeen.slice(0, 10000) : [];
  // History is optional: a row written before it existed restores with none rather
  // than failing to load.
  room.matchHistory = Array.isArray(data.matchHistory)
    ? data.matchHistory.slice(0, MAX_MATCH_HISTORY)
    : [];
  // Optional for the same reason as the history: rows written before tournaments
  // existed restore as an ordinary party.
  room.tournament = data.tournament ?? null;
  room.lastActivity = data.lastActivity;
  room.recoveryNotice = !!data.recoveryNotice || data.phase !== 'lobby' || !!data.starting;
  for (const id of room.config.selectedHoleIds) {
    if (!room.catalog.has(id)) {
      room.catalog.set(id, { id, title: data.titles?.[id] ?? id });
    }
  }
  // A restarted process cannot recover the original client physics state.
  // Restore as a lobby rather than resuming a partially scored round.
  room.phase = 'lobby';
  return { previousPhase: data.phase, recoveryNotice: room.recoveryNotice };
}
