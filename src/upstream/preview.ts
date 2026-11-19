/**
 * The preview proxy: course thumbnails fetched from upstream and cached.
 *
 * This endpoint cannot proxy arbitrary URLs — it only ever fetches the known
 * open-graph path of a course the public catalogue has named, bounds the image
 * it will accept, paces concurrent fetches and refuses rather than queue
 * forever when upstream is slow.
 */
import { UPSTREAM_ORIGIN } from './transport.js';
import { isListedCourse } from './catalog.js';

const PREVIEW_CACHE_TTL_MS = 300_000;
const MAX_PREVIEW_BYTES = 2_000_000;

interface PreviewImage {
  bytes: Buffer;
  type: string;
}

interface CacheEntry<Value> {
  at: number;
  promise: Promise<Value>;
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

function evictOldest<Key, Value>(cache: Map<Key, Value>, maximumSize: number): void {
  if (cache.size >= maximumSize) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value);
    }
  }
}

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
  const response = await fetch(UPSTREAM_ORIGIN + '/og/h/' + encodeURIComponent(id), {
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
  if (typeof id !== 'string' || !isListedCourse(id)) {
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

/** The cache size for the health report: a count only, never what was fetched. */
export function previewCacheSize() {
  return previewCache.size;
}
