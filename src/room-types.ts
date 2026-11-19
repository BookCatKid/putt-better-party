import type { BallAppearance } from './ball-cosmetics.js';
import type { ReplayRound } from './replays.js';
import type {
  CourseSpecification,
  LoadCourse,
  PrepareMatch,
  RoomConfig,
  RoomPhase,
} from './domain.js';
import type { Room } from './room.js';

export interface RoomSocket {
  data: { uid?: string | null };
  send(message: string): unknown;
  close(code?: number, reason?: string): unknown;
  /**
   * Bytes already queued for this socket, when the transport can report them.
   *
   * Bun's `ServerWebSocket` provides this, so the real socket satisfies the shape
   * without an adapter. It is optional because the test doubles and any other
   * transport need not implement it, and a socket that cannot report a backlog is
   * simply never considered backed up.
   */
  getBufferedAmount?(): number;
}

/**
 * A token bucket: capacity is the burst, and it refills at a fixed rate. The
 * server keeps one per connection so a single client cannot spend the room's
 * whole CPU, and one much smaller bucket for the frames that fan out to every
 * player, which are the ones worth flooding.
 */
export interface RateBudget {
  tokens: number;
  updatedAt: number;
}
export interface Identity {
  uid: string;
  session: string;
  name: string;
  hue: number;
  ball?: BallAppearance;
  colorOverride?: boolean;
  coHost?: boolean;
  hostSpectator?: boolean;
  puttingLocked?: boolean;
}
export interface Player {
  uid: string;
  name: string;
  hue: number;
  ball?: BallAppearance;
  id: string;
  ws: RoomSocket | null;
  instance?: unknown;
  role: 'player' | 'spectator';
  ready: boolean;
  alive: boolean;
  participated: boolean;
  holesSurvived: number;
  totalStrokes: number;
  totalTimeMs?: number;
  holeTimeMs?: number;
  strokes: number;
  done: boolean;
  success?: boolean;
  roundSpectator?: boolean;
  /** Explicit host spectator selection persists until the host returns the player. */
  hostSpectator?: boolean;
  colorOverride?: boolean;
  coHost?: boolean;
  puttingLocked?: boolean;
  /** Server-controlled epoch separates individual attempts on the same course. */
  attempt?: number;
  strokeAdjustment?: number;
  /** A newcomer must wait until the room advances beyond this hole. */
  joinAfterHole?: number;
  /** The client reported its level prepared for the current round. */
  sceneReady?: boolean;
  /** The connected client declares that it reports scene readiness each round. */
  reportsSceneReadiness?: boolean;
  lastPosition?: number;
  /** Token buckets limiting this connection's frames; see `MESSAGE_BURST`. */
  messageBudget: RateBudget;
  boardBudget: RateBudget;
  /** True once the exhausted-budget audit has been written for this socket. */
  messageBudgetReported?: boolean;
}
export interface RoundScore {
  uid: string;
  strokes: number | null;
  timeMs?: number;
  status: 'holed' | 'ended' | 'eliminated' | 'timeout';
}
export type RoundStatus = 'ended' | 'skipped' | 'completed';
export interface RoundRecord {
  index: number;
  id: string;
  title: string;
  par?: number;
  status: RoundStatus;
  rows: RoundScore[];
}
/**
 * One completed match, kept for the party's history.
 *
 * Deliberately a summary and not a record: no course specification, no socket, no
 * session and no cosmetic choice. `courses` carries the public id, title and par -
 * metadata a results list needs - and `holes` is the true hole count even when the
 * course list is truncated. `standings` keeps the display name and the scores, so a
 * history entry can never be used to reconstruct a credential.
 */
export interface MatchHistoryCourse {
  id: string;
  title: string;
  par: number | null;
}
export interface MatchHistoryRow {
  name: string;
  rank: number;
  holesSurvived: number;
  totalStrokes: number;
  totalTimeMs: number;
}
export interface MatchSummary {
  matchId: string;
  endedAt: number;
  holes: number;
  courses: MatchHistoryCourse[];
  standings: MatchHistoryRow[];
}
export interface RoomOptions {
  countdown?: number;
  results?: number;
  votingMs?: number;
  voteRevealMs?: number;
  onIdle?: (room: Room) => void;
  onChange?: (room: Room) => void;
  onFinalize?: (room: Room) => void;
  onReplayRound?: (id: string, replay: ReplayRound) => boolean;
  prepareMatch?: PrepareMatch | null;
  loadMap?: LoadCourse | null;
}
export interface RoomCheckpoint {
  version: 1;
  code: string;
  hostToken: string;
  hostUid: string | null;
  issued: Identity[];
  bannedNames?: string[];
  config: RoomConfig;
  titles: Record<string, string>;
  randomSeen: string[];
  /** Completed matches, newest first. Absent in rows written before it existed. */
  matchHistory?: MatchSummary[];
  phase: RoomPhase;
  starting: boolean;
  lastActivity: number;
  recoveryNotice: boolean;
  /** Host authority handed over by the previous host, never its capability token. */
  hostTransfer?: {
    fromUid: string;
    toUid: string;
    at: number;
  } | null;
}

/** The original protocol uses abbreviated coordinate and completion keys. */
export interface BallPosition {
  id: string;
  x: number;
  y: number;
  z: number;
  px: number;
  pz: number;
  c: 0 | 1;
  m: 0 | 1;
  d?: number;
}

/** One row of the final or mid-round standings, ordered by `rank`. */
export interface Standing {
  uid: string;
  name: string;
  hue: number;
  ball?: BallAppearance;
  rank: number;
  holesSurvived: number;
  totalStrokes: number;
  totalTimeMs: number;
  holeTimeMs: number | null;
  alive: boolean;
  strokes: number;
  finished: boolean;
  /**
   * Whether the player still has a live socket.
   *
   * The roster has carried this for a while, but the results view reads
   * `standings`, which did not - so a player who dropped near the end of a match
   * was indistinguishable from one who simply lost. Results screens need to tell
   * those apart, and so does anyone reading a scorecard after the fact.
   */
  connected: boolean;
}

/** One row of the roster frame: who is present and what they may do. */
export interface RosterEntry {
  id: string;
  uid: string;
  name: string;
  hue: number;
  ball?: BallAppearance;
  role: 'player' | 'spectator';
  /** Set when the player is spectating; explains why, for the lobby chip. */
  spectatorReason: string | null;
  isHost: boolean;
  ready: boolean;
  alive: boolean;
  connected: boolean;
  colorOverride?: boolean;
  coHost?: boolean;
  hostSpectator?: boolean;
  puttingLocked?: boolean;
  attempt?: number;
  strokeAdjustment?: number;
  resetPending?: boolean;
}
export interface PartySnapshot {
  t: 'party';
  pausedAt?: number | null;
  playlistRevision?: number;
  recordEligible?: boolean;
  replayId?: string | null;
  recoveryNotice: boolean;
  randomHistoryCount: number;
  preparing: boolean;
  /** Countdown only: connected players whose scene has not reported ready. */
  awaitingPlayers: number;
  nextError: string | null;
  vote: {
    id: string;
    target: number;
    endsAt: number;
    choices: Array<{
      id: string;
      title: string;
      author: string;
      par: number;
      ratingAvg?: number;
      ratingCount?: number;
      votes: number;
    }>;
    ballots: Record<string, string>;
    /** Frozen server draw; endsAt now marks the end of its reveal. */
    resolution?: { winnerId: string; durationMs: number };
  } | null;
  playlistTitles: Record<string, string>;
  roundHistory: RoundRecord[];
  /** Completed matches in this party, newest first. */
  matchHistory: MatchSummary[];
  initialPlayers: number;
  phase: RoomPhase;
  holeIndex: number;
  holeIds: string[];
  currentMap: CourseSpecification | null;
  matchId: string | null;
  config: RoomConfig;
  startsAt: number;
  timerMs: number;
  now: number;
}
