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
}
export interface Player {
  uid: string;
  name: string;
  hue: number;
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
export interface RoomOptions {
  countdown?: number;
  results?: number;
  votingMs?: number;
  onIdle?: (room: Room) => void;
  onChange?: (room: Room) => void;
  onFinalize?: (room: Room) => void;
  prepareMatch?: PrepareMatch | null;
  loadMap?: LoadCourse | null;
}
export interface RoomCheckpoint {
  version: 1;
  code: string;
  hostToken: string;
  hostUid: string | null;
  issued: Identity[];
  config: RoomConfig;
  titles: Record<string, string>;
  randomSeen: string[];
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
  rank: number;
  holesSurvived: number;
  totalStrokes: number;
  totalTimeMs: number;
  holeTimeMs: number | null;
  alive: boolean;
  strokes: number;
  finished: boolean;
}

/** One row of the roster frame: who is present and what they may do. */
export interface RosterEntry {
  id: string;
  uid: string;
  name: string;
  hue: number;
  role: 'player' | 'spectator';
  /** Set when the player is spectating; explains why, for the lobby chip. */
  spectatorReason: string | null;
  isHost: boolean;
  ready: boolean;
  alive: boolean;
  connected: boolean;
}
export interface PartySnapshot {
  t: 'party';
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
  } | null;
  playlistTitles: Record<string, string>;
  roundHistory: RoundRecord[];
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
