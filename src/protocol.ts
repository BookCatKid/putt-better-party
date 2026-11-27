/**
 * The party wire protocol, in one place.
 *
 * The client and server exchange JSON frames over a WebSocket, and the original
 * pinned bundle is one of the two speakers. Its field names are therefore a
 * compatibility contract: `t`, `b`, `f`, `s`, `p`, `prog`, `st` and the rest are
 * what the archived JavaScript actually reads and writes, so they must not be
 * renamed to something tidier. What this module adds is a description of those
 * frames precise enough for the authored code on both ends to be checked against.
 *
 * Two directions are kept apart on purpose:
 *
 *  - `ClientFrame` is what the client sends. Several frames also carry the round
 *    identity (`matchId`, `holeIndex`) which the transport attaches rather than
 *    the caller, so those fields are optional here and required by the server's
 *    stale-round check.
 *  - `ServerFrame` is what the server sends. The original client handles only the
 *    frames it knows and ignores anything else, so this union must include every
 *    frame the server can emit — a frame missing from it is a frame the client
 *    would silently drop.
 *
 * The types are structural descriptions of the wire, not validators. Runtime
 * validation still happens at the boundary (`readJsonObject`, the room's own
 * `handle`, and `parseStoredRoomPayload`); this module exists so a shape mismatch
 * is a compile error instead of a field that quietly reads `undefined`.
 */

import type {
  BallPosition,
  PartySnapshot,
  RosterEntry,
  RoundRecord,
  Standing,
} from './room-types.js';
import type { RoomPhase } from './domain.js';

/** A player's colour, used to tint their ghost and roster chip. */
export interface PlayerIdentity {
  uid: string;
  name: string;
  hue: number;
}

/** The round identity every round-scoped frame carries. */
export interface RoundIdentity {
  matchId: string | null;
  holeIndex: number;
  attempt?: number;
}

/**
 * A host command. The set is closed because the server rejects anything else as
 * `unknown`, so listing it here keeps the client and the server's switch in step.
 */
export type { HostAction } from './host-actions.js';
import type { HostAction } from './host-actions.js';

/* ------------------------------------------------------------------ client */

/** Sent once, before the socket is authenticated, to claim an identity. */
export interface JoinFrame {
  t: 'join';
  identity?: PlayerIdentity;
  code?: string;
  session?: string;
  spectate?: boolean;
}

/** Lobby ready flag. Distinct from `scene`: readiness is intent, `scene` is render. */
export interface ReadyFrame {
  t: 'ready';
  v: boolean;
}

/**
 * The renderer has prepared a level. The loading-fairness gate keys on this, and
 * it is only meaningful for clients that opt in by sending it.
 */
export interface SceneFrame extends Partial<RoundIdentity> {
  t: 'scene';
  levelId: string;
}

/** A stroke count update. `st` is the original wire name for strokes. */
export interface ProgressFrame extends Partial<RoundIdentity> {
  t: 'prog';
  st: number;
}

export interface ForfeitFrame extends Partial<RoundIdentity> {
  t: 'forfeit';
  replay?: unknown;
}

export interface ReplaySamplesFrame extends RoundIdentity {
  t: 'replay-samples';
  replay: unknown;
}

/**
 * The exact input of one stroke.
 *
 * This frame is an addition to the original protocol, not part of it: the pinned
 * bundle keeps every shot in `gameStore.state.shots` but never sends them, so
 * without this frame the server sees a trajectory and a stroke count and cannot
 * check that either came from a real shot. `dir` is the unit vector in the
 * course's xz plane and `power` is the client's own `0 < p <= 1` charge, so the
 * pair is everything the physics needs to reproduce the stroke.
 *
 * It is sent when the shot is fired rather than batched with the trajectory,
 * because the server wants the input *before* the result it is used to check.
 */
export interface ShotFrame extends RoundIdentity {
  t: 'shot';
  /** Unit vector `[x, z]` in the direction the ball is struck. */
  dir: [number, number];
  /** Charge in `(0, 1]`, where 1 is the client's maximum pull. */
  power: number;
}

/**
 * The synthetic completion frame. `f: 1` is the original bundle's "I holed out"
 * signal, carrying strokes in `s` and par in `p`. It is kept verbatim because the
 * bundle writes these exact keys.
 */
export interface FinishFrame extends Partial<RoundIdentity> {
  f: 1;
  s: number;
  p: number;
  replay?: unknown;
}

export interface PingFrame {
  t: 'ping';
}

/** A host configuration edit, sent as a partial config by the lobby. */
export interface ConfigFrame {
  t: 'config';
  config: Record<string, unknown>;
}

export interface StartFrame {
  t: 'start';
}

export interface CourseVoteFrame {
  t: 'course-vote';
  /** The vote this ballot belongs to, so a late ballot cannot count in a later one. */
  voteId: string;
  courseId: string;
}

/** A deliberate departure, which hands host authority on at once. */
export interface LeaveFrame {
  t: 'leave';
}

/** Play again after the final board. */
export interface RematchFrame {
  t: 'rematch';
}

/**
 * A ghost position update. This frame has no `t` at all: the original bundle
 * writes the coordinate object straight to the socket, and the server
 * distinguishes it by the presence of the coordinate keys. It is listed here so
 * the discriminator-free shape is recorded rather than assumed away.
 */
export interface PositionUpdateFrame extends Partial<RoundIdentity> {
  x: number;
  y: number;
  z: number;
  px: number;
  pz: number;
  c: 0 | 1;
  m: 0 | 1;
  /** Distance to the cup, omitted when the hole has no cup. */
  d?: number;
}

/** A host command, optionally acknowledged by `requestId`. */
export interface HostActionFrame extends Partial<RoundIdentity> {
  t: 'host-action';
  action: HostAction;
  requestId?: string;
  seconds?: number;
  uid?: string;
  value?: string | number | boolean;
  ids?: string[];
  revision?: number;
}

export type ClientFrame =
  | JoinFrame
  | ReadyFrame
  | SceneFrame
  | ProgressFrame
  | ForfeitFrame
  | ReplaySamplesFrame
  | ShotFrame
  | FinishFrame
  | PingFrame
  | ConfigFrame
  | StartFrame
  | CourseVoteFrame
  | LeaveFrame
  | RematchFrame
  | HostActionFrame
  | PositionUpdateFrame;

/* ------------------------------------------------------------------ server */

export interface HelloFrame {
  t: 'hello';
  id: string;
  isHost: boolean;
  count: number;
  role: 'player' | 'spectator';
}

export interface PongFrame {
  t: 'pong';
}

/**
 * The authoritative snapshot. Reused from the room's own type rather than
 * redeclared, so the server cannot widen the snapshot without this contract
 * noticing.
 */
export type PartyFrame = PartySnapshot;

export interface RosterFrame {
  t: 'roster';
  players: RosterEntry[];
}

export interface BoardFrame {
  t: 'board';
  standings: Standing[];
  alive: number;
  holed: number;
}

export interface FinalFrame {
  t: 'final';
  podium: Standing[];
  standings: Standing[];
}

export interface ByeFrame {
  t: 'bye';
  id: string;
}

/** Another player finished. `s` strokes for `p` par. */
export interface CompletionFrame {
  t: 'f';
  id: string;
  s: number;
  p: number;
}

export interface ErrorFrame {
  t: 'error';
  code: string;
  msg: string;
}

/** A batch of ghost positions. `s` is the original wire name for "samples". */
export interface PositionsFrame {
  t: 'b';
  s: BallPosition[];
}

/**
 * Authority moved to this socket. `token` is the rotated capability the new
 * host must adopt; `fromUid` is who held it before. Both names are the original
 * wire keys read by `adoptHostAuthority` in the transport.
 */
export interface HostGrantedFrame {
  t: 'host-granted';
  fromUid: string | null;
  token: string;
}

/** Authority was taken away; `uid` is the player who now holds it. */
export interface HostRevokedFrame {
  t: 'host-revoked';
  uid: string;
}

export interface HostAckFrame {
  t: 'host-ack';
  requestId: string;
  ok: boolean;
  msg?: string;
}

export interface CourseVoteUpdateFrame {
  t: 'course-vote';
  vote: PartySnapshot['vote'];
  now: number;
}

export interface HostNoticeFrame {
  t: 'host-notice';
  message: string;
}

export type ServerFrame =
  | HelloFrame
  | PongFrame
  | PartyFrame
  | RosterFrame
  | BoardFrame
  | FinalFrame
  | ByeFrame
  | CompletionFrame
  | ErrorFrame
  | PositionsFrame
  | HostGrantedFrame
  | HostRevokedFrame
  | HostAckFrame
  | CourseVoteUpdateFrame
  | HostNoticeFrame;

/** Server error codes the client must treat as terminal. */
export const TERMINAL_ERROR_CODES = ['invalid-join', 'full'] as const;
export type TerminalErrorCode = (typeof TERMINAL_ERROR_CODES)[number];

export function isTerminalErrorCode(code: string): code is TerminalErrorCode {
  return (TERMINAL_ERROR_CODES as readonly string[]).includes(code);
}

/*
 * The unions above are compile-time only, which is no use to a test that wants to
 * compare them against what the server and client actually emit. These tables fix
 * that: each one is a `Record` keyed by the union's own `t` values, so leaving a
 * frame out of the table, or naming one the union does not have, is a type error.
 * The exported arrays are then just the keys, and a test can read the real source
 * files and assert the two agree.
 */

/**
 * Client frames that carry a `t` discriminator. The completion frame (`f: 1`)
 * and the position update are both discriminator-free on the wire, so they are
 * excluded here and listed by their own keys instead.
 */
type TaggedClientFrame = Exclude<ClientFrame, PositionUpdateFrame | FinishFrame>;
export type ClientFrameTag = TaggedClientFrame['t'];

const CLIENT_FRAME_TAGS: Record<ClientFrameTag, true> = {
  join: true,
  ready: true,
  scene: true,
  prog: true,
  forfeit: true,
  'replay-samples': true,
  shot: true,
  ping: true,
  config: true,
  start: true,
  'course-vote': true,
  leave: true,
  rematch: true,
  'host-action': true,
};

export const CLIENT_FRAME_TAG_LIST = Object.keys(CLIENT_FRAME_TAGS) as ClientFrameTag[];

/**
 * Client frames with no `t` tag, named by how the wire identifies them. `f`
 * marks the completion frame and `position` the raw coordinate object, which the
 * server recognises by its own keys.
 */
export const CLIENT_UNTAGGED_FRAME_KINDS = ['f', 'position'] as const;
export type ClientUntaggedFrameKind = (typeof CLIENT_UNTAGGED_FRAME_KINDS)[number];

export type ServerFrameTag = ServerFrame['t'];

const SERVER_FRAME_TAGS: Record<ServerFrameTag, true> = {
  hello: true,
  pong: true,
  party: true,
  roster: true,
  board: true,
  final: true,
  bye: true,
  f: true,
  error: true,
  b: true,
  'host-granted': true,
  'host-revoked': true,
  'host-ack': true,
  'host-notice': true,
  'course-vote': true,
};

export const SERVER_FRAME_TAG_LIST = Object.keys(SERVER_FRAME_TAGS) as ServerFrameTag[];

/** The phases a round can be in, re-exported so the client needs one import. */
export type { RoomPhase, RoundRecord, Standing };
