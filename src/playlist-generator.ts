import { featuredDailyIds } from './random-selection.js';
import { isRecord, type Browse, type PublicHole, type CourseSpecification } from './domain.js';

const ranges = {
  rating: [0, 5],
  ratings: [0, 1_000_000],
  par: [1, 200],
  average: [0, 200],
  overPar: [-200, 200],
} as const;
type Metric = keyof typeof ranges;
type Range = { min?: number; max?: number };
export type Filters = {
  search: string;
  daily: 'any' | 'exclude' | 'only';
  sort: 'new' | 'top' | 'trending' | 'shuffle';
  mode: 'replace' | 'append';
  ranges: Partial<Record<Metric, Range>>;
};
export function parseFilters(value: unknown): Filters {
  if (!isRecord(value) || !isRecord(value.ranges)) {
    throw new Error('Invalid playlist filters');
  }
  const daily = value.daily;
  const sort = value.sort;
  const mode = value.mode;
  if (
    (daily !== 'any' && daily !== 'exclude' && daily !== 'only') ||
    (sort !== 'new' && sort !== 'top' && sort !== 'trending' && sort !== 'shuffle') ||
    (mode !== 'replace' && mode !== 'append') ||
    typeof value.search !== 'string' ||
    value.search.length > 100
  ) {
    throw new Error('Invalid playlist filters');
  }
  const selected: Filters['ranges'] = {};
  for (const [metric, range] of Object.entries(value.ranges)) {
    if (!Object.hasOwn(ranges, metric) || !isRecord(range)) {
      throw new Error('Invalid playlist range');
    }
    const key = metric as Metric;
    const [lower, upper] = ranges[key];
    const parsed: Range = {};
    for (const bound of ['min', 'max'] as const) {
      const number = range[bound];
      if (number === undefined || number === null || number === '') {
        continue;
      }
      if (
        typeof number !== 'number' ||
        !Number.isFinite(number) ||
        number < lower ||
        number > upper ||
        (['par', 'ratings'].includes(key) && !Number.isInteger(number))
      ) {
        throw new Error('Invalid ' + metric + ' range');
      }
      parsed[bound] = number;
    }
    if (parsed.min !== undefined && parsed.max !== undefined && parsed.min > parsed.max) {
      throw new Error('Minimum exceeds maximum for ' + metric);
    }
    if (parsed.min !== undefined || parsed.max !== undefined) {
      selected[key] = parsed;
    }
  }
  return { search: value.search.trim(), daily, sort, mode, ranges: selected };
}
function matches(range: Range | undefined, value: unknown) {
  return (
    !range ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      (range.min === undefined || value >= range.min) &&
      (range.max === undefined || value <= range.max))
  );
}
export interface PlaylistProgress {
  scanned: number;
  total: number;
  matched: number;
}
type ScanDependencies = {
  browse: Browse;
  stats: (id: string) => Promise<{ avgStrokes: number | null }>;
  specification: (id: string) => Promise<CourseSpecification>;
  currentDay: () => number;
  allowed: () => boolean;
  progress: (progress: PlaylistProgress) => void;
};
export async function generatePlaylist(
  filters: Filters,
  deps: ScanDependencies,
): Promise<PublicHole[]> {
  const selected: PublicHole[] = [];
  const seen = new Set<string>();
  let offset: number | null = 0;
  let total: number | null = null;
  const day = deps.currentDay();
  const check = () => {
    if (!deps.allowed()) {
      throw new Error('Playlist generation cancelled or lobby changed');
    }
  };
  const excluded =
    filters.daily === 'exclude'
      ? await featuredDailyIds(async (options) => {
          check();
          return deps.browse(options);
        }, day)
      : new Set<string>();
  const minimumRating = filters.ranges.rating?.min ?? 0;
  let minRating = 0;
  if (minimumRating >= 4) {
    minRating = 4;
  } else if (minimumRating >= 3) {
    minRating = 3;
  }
  while (offset !== null) {
    check();
    const page = await deps.browse({
      offset,
      sort: filters.sort === 'shuffle' ? 'new' : filters.sort,
      search: filters.search,
      minRating,
      daily: filters.daily === 'only',
      fresh: true,
    });
    if (
      !Number.isInteger(page.total) ||
      page.total < 0 ||
      page.total > 10_000 ||
      (page.nextOffset !== null &&
        (!Number.isInteger(page.nextOffset) ||
          page.nextOffset <= offset ||
          page.nextOffset > 10_000))
    ) {
      throw new Error(
        'The catalog exceeds its supported pagination range or changed while scanning',
      );
    }
    if (total !== null && total !== page.total) {
      throw new Error('The catalog changed while scanning. Please try again.');
    }
    total = page.total;
    for (const hole of page.holes) {
      check();
      if (seen.has(hole.id)) {
        continue;
      }
      seen.add(hole.id);
      if (seen.size > total) {
        throw new Error('The catalog changed while scanning. Please try again.');
      }
      const featured =
        excluded.has(hole.id) ||
        (typeof hole.scheduledDay === 'number' && hole.scheduledDay <= day) ||
        (filters.daily === 'only' && hole.scheduledDay == null);
      const pass =
        (filters.daily !== 'exclude' || !featured) &&
        (filters.daily !== 'only' || featured) &&
        matches(filters.ranges.rating, hole.ratingAvg) &&
        matches(filters.ranges.ratings, hole.ratingCount);
      if (pass) {
        // Fast metadata filters first; only retrieve statistics or geometry
        // when needed. Unknown measurements do not match numeric bounds.
        const average =
          filters.ranges.average || filters.ranges.overPar
            ? (await deps.stats(hole.id)).avgStrokes
            : null;
        check();
        if (
          matches(filters.ranges.average, average) &&
          (!filters.ranges.overPar || average !== null)
        ) {
          const par =
            filters.ranges.par || filters.ranges.overPar
              ? (await deps.specification(hole.id)).par
              : null;
          check();
          if (
            matches(filters.ranges.par, par) &&
            matches(filters.ranges.overPar, average !== null && par !== null ? average - par : null)
          ) {
            selected.push(hole);
          }
        }
      }
      deps.progress({ scanned: seen.size, total, matched: selected.length });
    }
    offset = page.nextOffset;
  }
  // Offset pagination may shift if the community catalog changes mid-scan.
  // Never silently publish a partial scan when the count reveals it.
  if (seen.size !== total) {
    throw new Error('The catalog changed while scanning. Please try again.');
  }
  check();
  if (filters.sort === 'shuffle') {
    for (let index = selected.length - 1; index > 0; index--) {
      const other = Math.floor(Math.random() * (index + 1));
      [selected[index], selected[other]] = [selected[other], selected[index]];
    }
  }
  return selected;
}

type Job = {
  status: 'running' | 'complete' | 'cancelled' | 'failed';
  progress: PlaylistProgress;
  error?: string;
  at: number;
};
export class PlaylistJobs {
  private jobs = new Map<string, Job>();
  private active: Job | null = null;
  get(code: string) {
    return this.jobs.get(code) ?? null;
  }
  cancel(code: string) {
    const job = this.jobs.get(code);
    if (job?.status === 'running') {
      job.status = 'cancelled';
    }
    return job ?? null;
  }
  start(
    code: string,
    filters: Filters,
    deps: Omit<ScanDependencies, 'progress'>,
    apply: (holes: PublicHole[]) => void,
  ) {
    if (this.active) {
      throw new Error('A playlist is already being generated. Try again after it finishes.');
    }
    const now = Date.now();
    for (const [key, previous] of this.jobs) {
      if (now - previous.at > 30 * 60_000) {
        this.jobs.delete(key);
      }
    }
    const job: Job = { status: 'running', progress: { scanned: 0, total: 0, matched: 0 }, at: now };
    this.jobs.set(code, job);
    this.active = job;
    void generatePlaylist(filters, {
      ...deps,
      allowed: () => job.status === 'running' && deps.allowed(),
      progress: (progress) => {
        job.progress = progress;
      },
    })
      .then((holes) => {
        if (job.status === 'running' && deps.allowed()) {
          if (holes.length) {
            apply(holes);
          }
          job.status = 'complete';
        } else {
          job.status = 'cancelled';
        }
      })
      .catch((error: unknown) => {
        if (job.status !== 'cancelled') {
          job.status = deps.allowed() ? 'failed' : 'cancelled';
          job.error = error instanceof Error ? error.message : String(error);
        }
      })
      .finally(() => {
        job.at = Date.now();
        this.active = null;
      });
    return job;
  }
}
