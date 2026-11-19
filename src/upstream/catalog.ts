/**
 * The community catalogue and the metadata index behind it.
 *
 * `listedCourses` is both a small metadata cache and the "was this course
 * listed?" check behind `publicStats` and preview: only a course the public
 * catalogue has named may be statted or previewed. Browsing pages are cached
 * briefly because the same queries repeat while a picker is open.
 */
import { isRecord, type BrowseOptions, type CatalogPage, type PublicHole } from '../domain.js';
import { LIST, STATS, callPublicFunction } from './transport.js';

const CATALOG_CACHE_TTL_MS = 120_000;

interface CacheEntry<Value> {
  at: number;
  promise: Promise<Value>;
}

const catalogCache = new Map<string, CacheEntry<CatalogPage>>();
const listedCourses = new Map<string, PublicHole>();
/**
 * How many catalogued courses are remembered.
 *
 * This map grew with **every course ever listed** — unbounded for the life of
 * the process. The bound is deliberately generous, far more than one session
 * browses, because eviction only loses metadata: playability never depends on
 * it. A room keeps its own course index, and a match start re-fetches every
 * course with `saved: true`, which does not consult this map.
 */
const MAX_LISTED_COURSES = 5000;

function evictOldest<Key, Value>(cache: Map<Key, Value>, maximumSize: number): void {
  if (cache.size >= maximumSize) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
}

/**
 * Remember a listed course, refreshing its position so eviction is
 * least-recently seen rather than first-ever-seen: a course still appearing on
 * a catalogue page should not be the one dropped.
 */
export function rememberListed(entry: PublicHole): void {
  listedCourses.delete(entry.id);
  listedCourses.set(entry.id, entry);
  evictOldest(listedCourses, MAX_LISTED_COURSES);
}

/** Whether the public catalogue has named this course in this process. */
export function isListedCourse(id: string): boolean {
  return listedCourses.has(id);
}

/** The metadata a catalogue page recorded for a course, if it was listed. */
export function listedCourse(id: string): PublicHole | undefined {
  return listedCourses.get(id);
}

function parseCatalogPage(result: unknown): CatalogPage {
  if (
    !isRecord(result) ||
    !Array.isArray(result.holes) ||
    typeof result.total !== 'number' ||
    typeof result.offset !== 'number' ||
    !(result.nextOffset === null || typeof result.nextOffset === 'number')
  ) {
    throw new Error('Unexpected public catalog response');
  }
  const holes: PublicHole[] = [];
  for (const hole of result.holes) {
    if (!isRecord(hole) || typeof hole.id !== 'string' || typeof hole.title !== 'string') {
      continue;
    }
    const metadata: PublicHole = {
      id: hole.id,
      title: hole.title,
      author: typeof hole.author === 'string' ? hole.author : '',
      creatorId: hole.creatorId,
      createdAt: hole.createdAt,
      ratingAvg: hole.ratingAvg,
      ratingCount: hole.ratingCount,
      scheduledDay:
        typeof hole.scheduledDay === 'number' || hole.scheduledDay === null
          ? hole.scheduledDay
          : undefined,
      completionsBucket: hole.completionsBucket,
    };
    holes.push(metadata);
    rememberListed(metadata);
  }
  return { holes, total: result.total, offset: result.offset, nextOffset: result.nextOffset };
}

export async function browse({
  search = '',
  sort = 'new',
  offset = 0,
  minRating = 0,
  daily = false,
  author = '',
  fresh = false,
}: BrowseOptions = {}): Promise<CatalogPage> {
  const rating = Number(minRating);
  const options = {
    search: String(search).trim().slice(0, 100) || undefined,
    sort: ['new', 'trending', 'top'].includes(sort) ? sort : 'new',
    limit: 24,
    offset: Math.max(0, Math.min(10_000, Math.trunc(Number(offset) || 0))),
    minRating: [3, 4].includes(rating) ? rating : undefined,
    daily: daily === true || daily === 'true' ? true : undefined,
    author: typeof author === 'string' && author.length <= 100 && author ? author : undefined,
  };

  const key = JSON.stringify(options);
  const cachedPage = catalogCache.get(key);
  if (!fresh && cachedPage && Date.now() - cachedPage.at < CATALOG_CACHE_TTL_MS) {
    return cachedPage.promise;
  }

  const promise = callPublicFunction(LIST, options)
    .then(parseCatalogPage)
    .catch((error: unknown) => {
      if (catalogCache.get(key)?.promise === promise) {
        catalogCache.delete(key);
      }
      throw error;
    });
  evictOldest(catalogCache, 128);
  catalogCache.set(key, { at: Date.now(), promise });
  return promise;
}

/** Public hole statistics only. Never request or expose the admin-only exact fields. */
export async function publicStats(id: string) {
  if (!isListedCourse(id)) {
    throw new Error('Choose a hole from the public catalog first');
  }
  const result = await callPublicFunction(STATS, { id });
  if (!isRecord(result) || !('avgStrokes' in result)) {
    throw new Error('Unexpected public hole statistics');
  }
  return {
    avgStrokes:
      typeof result.avgStrokes === 'number' && Number.isFinite(result.avgStrokes)
        ? result.avgStrokes
        : null,
  };
}

export function publicRating(id: string) {
  const listed = listedCourses.get(id);
  return {
    ratingAvg:
      typeof listed?.ratingAvg === 'number' && Number.isFinite(listed.ratingAvg)
        ? listed.ratingAvg
        : undefined,
    ratingCount:
      typeof listed?.ratingCount === 'number' && Number.isFinite(listed.ratingCount)
        ? listed.ratingCount
        : undefined,
  };
}

export function rememberPublicMetadata(id: string, title?: string): void {
  if (/^[a-zA-Z0-9_-]{5,64}$/.test(id) && !isListedCourse(id)) {
    rememberListed({ id, title });
  }
}

/** Cache sizes for the health report: counts only, never what was looked at. */
export function catalogMetrics() {
  return {
    catalogPages: catalogCache.size,
    knownCourses: listedCourses.size,
  };
}
