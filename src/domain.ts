/** Application-owned contracts. The original client's wire keys are not renamed. */
export const MAP_SOURCE = { RANDOM: 'random', PICKED: 'picked' } as const;
export type MapSource = (typeof MAP_SOURCE)[keyof typeof MAP_SOURCE];
export const LATE_JOIN = { NEVER: 'never', NEXT_HOLE: 'next-hole', ALWAYS: 'always' } as const;
export type LateJoinPolicy = (typeof LATE_JOIN)[keyof typeof LATE_JOIN];
export type RoomPhase = 'lobby' | 'countdown' | 'playing' | 'hole-results' | 'final';

export interface RoomConfig {
  holes: number;
  timerMs: number;
  elimination: boolean;
  maxPlayers: number;
  mapSource: MapSource;
  selectedHoleIds: string[];
  locked: boolean;
  excludeDaily: boolean;
  randomHoles: number;
  lateJoin: LateJoinPolicy;
  courseVoting: boolean;
  /** Team play: players are split into two teams and the party is scored by team. */
  teams: boolean;
  /** Tournament: several matches in sequence, ranked by accumulated points. */
  tournament: boolean;
  /** How many matches one tournament runs for. */
  tournamentRounds: number;
}

/** The original game owns the rest of the specification's schema. */
export interface CourseSpecification {
  par: number;
  name?: string;
  [property: string]: unknown;
}

export interface CourseMetadata {
  id?: string;
  title?: string;
  author?: string;
  par?: number;
  ratingAvg?: number;
  ratingCount?: number;
}
export interface CatalogEntry extends CourseMetadata {
  spec?: CourseSpecification;
}
export interface PublicCourse extends CourseMetadata {
  id: string;
  title: string;
  author: string;
  par: number;
  spec: CourseSpecification;
}

/** Room recovery only needs metadata; only the catalog service adds playable courses. */
export interface CourseIndex {
  get(id: string): CatalogEntry | undefined;
  has(id: string): boolean;
  keys(): IterableIterator<string>;
  set(id: string, entry: CatalogEntry): unknown;
}

/** The configuration a room starts with before the host changes anything. */
export const defaults: Readonly<RoomConfig> = Object.freeze({
  holes: 3,
  timerMs: 60000,
  elimination: true,
  maxPlayers: 50,
  mapSource: MAP_SOURCE.RANDOM,
  selectedHoleIds: [],
  locked: false,
  excludeDaily: false,
  randomHoles: 3,
  lateJoin: LATE_JOIN.ALWAYS,
  courseVoting: false,
  teams: false,
  tournament: false,
  tournamentRounds: 3,
});

/**
 * How many completed matches a party keeps, and how many courses per match.
 *
 * A history entry is a summary, not a recording. Ten matches covers an evening's
 * play without letting a long-lived party accumulate; a hundred courses covers any
 * normal playlist, and a longer one keeps its true hole count even though the course
 * list is truncated. The cap exists because this is persisted with the room.
 */
export const MAX_MATCH_HISTORY = 10;
export const MAX_HISTORY_COURSES = 100;
export interface PreparedMatch {
  ids: string[];
  specs: CourseSpecification[];
  seen?: string[];
  ballots?: PublicCourse[][];
}
export type PrepareMatch = (
  config: RoomConfig,
  seen: string[],
) => Promise<PreparedMatch> | PreparedMatch;
export type LoadCourse = (
  id: string,
) =>
  | Promise<PublicCourse | { spec: CourseSpecification }>
  | PublicCourse
  | { spec: CourseSpecification };

export interface BrowseOptions {
  search?: string;
  sort?: string;
  offset?: number | string;
  minRating?: number | string;
  daily?: boolean | string;
  author?: string;
  fresh?: boolean;
}
export interface PublicHole {
  id: string;
  title?: string;
  author?: string;
  scheduledDay?: number | null;
  [property: string]: unknown;
}
export interface CatalogPage {
  holes: PublicHole[];
  total: number;
  offset?: number;
  nextOffset: number | null;
}
export type Browse = (options: BrowseOptions) => Promise<CatalogPage>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
