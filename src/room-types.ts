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
  strokes: number;
  done: boolean;
  success?: boolean;
  roundSpectator?: boolean;
  lastPosition?: number;
}
export interface RoundScore {
  uid: string;
  strokes: number | null;
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
  onIdle?: (room: Room) => void;
  onChange?: (room: Room) => void;
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
export interface PartySnapshot {
  t: 'party';
  recoveryNotice: boolean;
  randomHistoryCount: number;
  preparing: boolean;
  nextError: string | null;
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
