import { isRecord, type BrowseOptions, type CatalogPage, type PublicHole } from './domain.js';
import { invokePublicFunction } from './upstream/client-adapter.js';
import { PacedRequestQueue } from './upstream/request-queue.js';

// Pinned, read-only server functions recovered from the original client.
// The DETAIL POST retrieves a public hole; it does not mutate upstream data.
const LIST_FUNCTION = 'f97883d5e5a6b99b27465e8906c5bb388ff1314417b2b803d49645320e231be7';
const DETAIL_FUNCTION = 'fd5b893e239211c8e662cb5e9d4f489b73a752eaf01715a1a8c41808babe622d';
// HoleStats and the community list both call the same public GET with {id}.
const STATS_FUNCTION = '49e860e80c9478a9875955d36bf5de9158615b51135baa8e2a76cfd2b0f39599';
const ORIGIN = 'https://putt.day';
const REQUEST_INTERVAL_MS = 350;
const MAX_ACTIVE_REQUESTS = 3;
const CATALOG_CACHE_TTL_MS = 120_000;
const PREVIEW_CACHE_TTL_MS = 300_000;
const MAX_PREVIEW_BYTES = 2_000_000;

const publicOperations = new Map<string, 'GET' | 'POST'>([
  [LIST_FUNCTION, 'GET'],
  [DETAIL_FUNCTION, 'POST'],
  [STATS_FUNCTION, 'GET'],
]);

interface CacheEntry<Value> {
  at: number;
  promise: Promise<Value>;
}

const catalogCache = new Map<string, CacheEntry<CatalogPage>>();
const listedCourses = new Map<string, PublicHole>();
/**
 * How many catalogued courses are remembered.
 *
 * This map is both a small metadata cache and the "was this course listed?" check
 * behind `publicStats` and preview, and it grew with **every course ever listed** —
 * unbounded for the life of the process. The bound is deliberately generous, far
 * more than one session browses, because eviction only loses metadata: playability
 * never depends on it. A room keeps its own course index, and a match start
 * re-fetches every course with `saved: true`, which does not consult this map.
 */
const MAX_LISTED_COURSES = 5000;
const requestQueue = new PacedRequestQueue(MAX_ACTIVE_REQUESTS, REQUEST_INTERVAL_MS);

/**
 * Remember a listed course, refreshing its position so eviction is least-recently
 * seen rather than first-ever-seen: a course still appearing on a catalogue page
 * should not be the one dropped.
 */
function rememberListed(entry: PublicHole): void {
  listedCourses.delete(entry.id);
  listedCourses.set(entry.id, entry);
  evictOldest(listedCourses, MAX_LISTED_COURSES);
}

async function publicFetch(relative: string, options: RequestInit): Promise<Response> {
  const url = new URL(relative, ORIGIN);
  const identifier = url.pathname.split('/').at(-1);
  if (
    url.origin !== ORIGIN ||
    !identifier ||
    url.pathname !== '/_serverFn/' + identifier ||
    publicOperations.get(identifier) !== options.method
  ) {
    throw new Error('Unexpected upstream operation');
  }

  const headers = new Headers(options.headers);
  headers.delete('cookie');
  headers.delete('authorization');
  headers.set('referer', ORIGIN + '/holes');

  return requestQueue.run(async () => {
    const response = await fetch(url, {
      ...options,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      throw new Error('Public catalog unavailable (HTTP ' + response.status + ')');
    }
    return response;
  });
}

async function callPublicFunction(identifier: string, data: unknown): Promise<unknown> {
  const method = publicOperations.get(identifier);
  if (!method) {
    throw new Error('Unexpected upstream operation');
  }
  return invokePublicFunction(identifier, method, data, publicFetch);
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

  const promise = callPublicFunction(LIST_FUNCTION, options)
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

function evictOldest<Key, Value>(cache: Map<Key, Value>, maximumSize: number): void {
  if (cache.size >= maximumSize) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
}

/** Public hole statistics only. Never request or expose the admin-only exact fields. */
export async function publicStats(id: string) {
  if (!listedCourses.has(id)) {
    throw new Error('Choose a hole from the public catalog first');
  }
  const result = await callPublicFunction(STATS_FUNCTION, { id });
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
  if (/^[a-zA-Z0-9_-]{5,64}$/.test(id) && !listedCourses.has(id)) {
    rememberListed({ id, title });
  }
}

export interface PublicCourseDetail {
  id: string;
  title: string;
  author: string;
  spec: unknown;
}

/**
 * The only way a course becomes playable. A detail response is accepted only
 * when upstream itself calls it public, names the course that was asked for and
 * carries a specification; anything else is a refusal, never a fallback to
 * locally stored geometry. Kept separate from the network call so this boundary
 * can be exercised directly.
 */
export class UnavailablePublicCourseError extends Error {
  constructor(readonly courseId: string) {
    super('Map is unavailable or not public');
  }
}

export function parsePublicCourseDetail(
  id: string,
  result: unknown,
  listed: { title?: string; author?: string } = {},
): PublicCourseDetail {
  if (!isRecord(result) || result.public !== true || result.id !== id || !result.spec) {
    throw new UnavailablePublicCourseError(id);
  }
  const metadata = { ...listed, ...result };
  // The title is the course's user-facing identity and the value the validator
  // writes over `spec.name`, so a blank one is a missing identity rather than a
  // later validation surprise.
  if (typeof metadata.title !== 'string' || !metadata.title.trim()) {
    throw new Error('Missing public course title');
  }
  return {
    id,
    title: metadata.title,
    author: typeof metadata.author === 'string' ? metadata.author : '',
    spec: result.spec,
  };
}

/**
 * Detail fetches that are already running, by course id.
 *
 * Two rooms importing the same course at the same time used to make two upstream
 * requests for identical data. Sharing the promise is safe because the response is
 * immutable and the per-call validation above still runs first, so a `saved: true`
 * caller and a plain caller each get the answer they are entitled to.
 *
 * The map is bounded by the fetch queue, not by the catalogue: an entry exists only
 * while its request does, and a request that cannot be admitted is refused before it
 * ever reaches here.
 */
const inflightDetails = new Map<string, Promise<PublicCourseDetail>>();

export async function detail(
  id: string,
  { saved = false }: { saved?: boolean } = {},
): Promise<PublicCourseDetail> {
  if (
    typeof id !== 'string' ||
    (!listedCourses.has(id) && !(saved && /^[a-zA-Z0-9_-]{5,64}$/.test(id)))
  ) {
    throw new Error('Choose a hole from the public catalog first');
  }
  const inflight = inflightDetails.get(id);
  if (inflight) {
    return inflight;
  }
  const promise = (async () => {
    const course = parsePublicCourseDetail(
      id,
      await callPublicFunction(DETAIL_FUNCTION, { id }),
      listedCourses.get(id),
    );
    if (!listedCourses.has(id)) {
      rememberListed({ id, title: course.title, author: course.author });
    }
    return course;
  })();
  inflightDetails.set(id, promise);
  // Both outcomes clear the entry. Attaching a handler for the rejection as well as
  // the resolution keeps this bookkeeping from surfacing as an unhandled rejection.
  const forget = () => {
    if (inflightDetails.get(id) === promise) {
      inflightDetails.delete(id);
    }
  };
  promise.then(forget, forget);
  return promise;
}

interface PreviewImage {
  bytes: Buffer;
  type: string;
}

const previewCache = new Map<string, CacheEntry<PreviewImage>>();
let activePreviewRequests = 0;
const previewWaiters: Array<() => void> = [];
/**
 * How many preview requests may wait for a slot. Like the catalog queue, the
 * waiting half is the one that looks free and therefore grows: a client that
 * keeps asking while upstream is slow would otherwise hold a closure and a
 * promise per request for as long as it kept asking. Refusing instead lets the
 * caller answer its own client rather than leave it waiting indefinitely.
 */
const MAXIMUM_WAITING_PREVIEWS = 64;

// Limit concurrency to four requests; waiting requests inherit a released slot.
async function withPreviewSlot<Value>(operation: () => Promise<Value>): Promise<Value> {
  if (activePreviewRequests >= 4) {
    if (previewWaiters.length >= MAXIMUM_WAITING_PREVIEWS) {
      throw new Error('Too many preview requests are already waiting');
    }
    await new Promise<void>((resolve) => previewWaiters.push(resolve));
  } else {
    activePreviewRequests++;
  }
  try {
    return await operation();
  } finally {
    const next = previewWaiters.shift();
    if (next) {
      next();
    } else {
      activePreviewRequests--;
    }
  }
}

async function fetchPreview(id: string): Promise<PreviewImage> {
  const response = await fetch(ORIGIN + '/og/h/' + encodeURIComponent(id), {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  const type = response.headers.get('content-type')?.split(';')[0];
  if (
    !response.ok ||
    !type ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(type) ||
    !response.body
  ) {
    throw new Error('Preview unavailable');
  }

  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_PREVIEW_BYTES) {
        throw new Error('Preview too large');
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { bytes: Buffer.concat(chunks, size), type };
}

/** Preview only a known public course; this endpoint cannot proxy arbitrary URLs. */
export async function preview(id: string): Promise<Response> {
  if (typeof id !== 'string' || !listedCourses.has(id)) {
    throw new Error('Select a public community hole first');
  }

  let cachedPreview = previewCache.get(id);
  if (!cachedPreview || Date.now() - cachedPreview.at > PREVIEW_CACHE_TTL_MS) {
    const promise = withPreviewSlot(() => fetchPreview(id)).catch((error: unknown) => {
      previewCache.delete(id);
      throw error;
    });
    evictOldest(previewCache, 64);
    cachedPreview = { at: Date.now(), promise };
    previewCache.set(id, cachedPreview);
  }

  const { bytes, type } = await cachedPreview.promise;
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': type,
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * What the upstream surface looks like right now, for the health report.
 *
 * These are counts and cache sizes rather than per-request detail, so reading
 * this cannot itself grow memory or leak what anybody looked at. No course id,
 * title or author is included: the catalog a client browses is its own business,
 * and a health endpoint is often the least protected surface on a service.
 */
export function upstreamMetrics() {
  return {
    queue: requestQueue.metrics(),
    caches: {
      catalogPages: catalogCache.size,
      knownCourses: listedCourses.size,
      previews: previewCache.size,
    },
  };
}
