// The two public read endpoints are pinned to the November 16 client.
// POST DETAIL is the read-only public hole-page loader, not a mutation.
import { n as serverRef } from '../private-client/assets/createServerFn-BfnFvdmx.js';
const LIST = 'f97883d5e5a6b99b27465e8906c5bb388ff1314417b2b803d49645320e231be7';
const DETAIL = 'fd5b893e239211c8e662cb5e9d4f489b73a752eaf01715a1a8c41808babe622d';
const allowed = new Map([
    [LIST, 'GET'],
    [DETAIL, 'POST'],
  ]),
  cache = new Map(),
  listed = new Map();
let queue = Promise.resolve(),
  last = 0;
globalThis.window ??= { __TSS_START_OPTIONS__: { serializationAdapters: [] } };
async function publicFetch(relative, opts) {
  const u = new URL(relative, 'https://putt.day'),
    id = u.pathname.split('/').at(-1);
  if (
    u.origin !== 'https://putt.day' ||
    u.pathname !== '/_serverFn/' + id ||
    allowed.get(id) !== opts.method
  )
    throw Error('Unexpected upstream operation');
  const headers = new Headers(opts.headers);
  headers.delete('cookie');
  headers.delete('authorization');
  headers.set('referer', 'https://putt.day/holes');
  const fetchOne = async () => {
    await new Promise((r) => setTimeout(r, Math.max(0, 700 - Date.now() + last)));
    last = Date.now();
    const r = await fetch(u, {
      ...opts,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) throw Error('Public catalog unavailable (HTTP ' + r.status + ')');
    return r;
  };
  const pending = queue.then(fetchOne);
  queue = pending.then(
    () => {},
    () => {},
  );
  return pending;
}
async function call(id, data) {
  const result = await serverRef(id)({ data, method: allowed.get(id), fetch: publicFetch });
  if (result?.error) throw Error(String(result.error));
  return result?.result;
}
export async function browse({
  search = '',
  sort = 'new',
  offset = 0,
  minRating = 0,
  daily = false,
  author = '',
  fresh = false,
} = {}) {
  search = String(search).trim().slice(0, 100);
  sort = ['new', 'trending', 'top'].includes(sort) ? sort : 'new';
  offset = Math.max(0, Math.min(10000, Math.trunc(Number(offset) || 0)));
  minRating = [3, 4].includes(Number(minRating)) ? Number(minRating) : undefined;
  const options = {
    search: search || undefined,
    sort,
    limit: 24,
    offset,
    minRating,
    daily: daily === true || daily === 'true' ? true : undefined,
    author: typeof author === 'string' && author.length <= 100 && author ? author : undefined,
  };
  const key = JSON.stringify(options),
    hit = cache.get(key);
  if (fresh !== true && hit && Date.now() - hit.at < 120000) return hit.promise;
  const promise = call(LIST, options)
    .then((result) => {
      if (!Array.isArray(result?.holes)) throw Error('Unexpected public catalog response');
      const holes = result.holes
        .filter((h) => typeof h.id === 'string' && typeof h.title === 'string')
        .map((h) => ({
          id: h.id,
          title: h.title,
          author: h.author || '',
          creatorId: h.creatorId,
          createdAt: h.createdAt,
          ratingAvg: h.ratingAvg,
          ratingCount: h.ratingCount,
          scheduledDay: h.scheduledDay,
          completionsBucket: h.completionsBucket,
        }));
      for (const h of holes) listed.set(h.id, h);
      return { holes, total: result.total, offset: result.offset, nextOffset: result.nextOffset };
    })
    .catch((e) => {
      cache.delete(key);
      throw e;
    });
  if (cache.size >= 128) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), promise });
  return promise;
}
export function rememberPublicMetadata(id, title) {
  if (/^[a-zA-Z0-9_-]{5,64}$/.test(id) && !listed.has(id)) listed.set(id, { id, title });
}
export async function detail(id, { saved = false } = {}) {
  if (typeof id !== 'string' || (!listed.has(id) && !(saved && /^[a-zA-Z0-9_-]{5,64}$/.test(id))))
    throw Error('Choose a hole from the public catalog first');
  const d = await call(DETAIL, { id });
  if (d?.public !== true || d.id !== id || !d.spec) throw Error('Map is unavailable or not public');
  if (!listed.has(id)) listed.set(id, { id, title: d.title, author: d.author || '' });
  return { ...listed.get(id), ...d };
}

// Preview route recovered from _site.holes-BZxjWLe4.js. Only a listed public ID
// may be requested. This cannot proxy arbitrary URLs.
const previews = new Map();
let previewActive = 0;
const previewWait = [];
async function previewSlot(fn) {
  if (previewActive >= 4) await new Promise((r) => previewWait.push(r));
  else previewActive++;
  try {
    return await fn();
  } finally {
    const next = previewWait.shift();
    if (next) next();
    else previewActive--;
  }
}
export async function preview(id) {
  if (typeof id !== 'string' || !listed.has(id))
    throw Error('Select a public community hole first');
  let hit = previews.get(id);
  if (!hit || Date.now() - hit.at > 300000) {
    const promise = previewSlot(async () => {
      const r = await fetch('https://putt.day/og/h/' + encodeURIComponent(id), {
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
      const type = r.headers.get('content-type')?.split(';')[0];
      if (!r.ok || !['image/png', 'image/jpeg', 'image/webp'].includes(type))
        throw Error('Preview unavailable');
      const reader = r.body.getReader();
      let size = 0;
      const chunks = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2000000) throw Error('Preview too large');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return { bytes: Buffer.concat(chunks, size), type };
    }).catch((e) => {
      previews.delete(id);
      throw e;
    });
    if (previews.size >= 64) previews.delete(previews.keys().next().value);
    hit = { at: Date.now(), promise };
    previews.set(id, hit);
  }
  const { bytes, type } = await hit.promise;
  return new Response(bytes, {
    headers: {
      'content-type': type,
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}
