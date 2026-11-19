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
