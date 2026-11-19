/**
 * Upstream transport: the only code that may open a connection to putt.day.
 *
 * Three pinned public server functions are reachable, each behind a checked
 * allowlist so a caller cannot turn this into a general proxy. Every request is
 * paced through the shared queue, carries no credentials, identifies itself
 * with the community-page referer the original client sends, and times out.
 * Nothing else in the service fetches upstream.
 */
import { invokePublicFunction } from './client-adapter.js';
import { PacedRequestQueue } from './request-queue.js';

// Pinned, read-only server functions recovered from the original client.
// The DETAIL POST retrieves a public hole; it does not mutate upstream data.
const LIST_FUNCTION = 'f97883d5e5a6b99b27465e8906c5bb388ff1314417b2b803d49645320e231be7';
const DETAIL_FUNCTION = 'fd5b893e239211c8e662cb5e9d4f489b73a752eaf01715a1a8c41808babe622d';
// HoleStats and the community list both call the same public GET with {id}.
const STATS_FUNCTION = '49e860e80c9478a9875955d36bf5de9158615b51135baa8e2a76cfd2b0f39599';
const ORIGIN = 'https://putt.day';
const REQUEST_INTERVAL_MS = 350;
const MAX_ACTIVE_REQUESTS = 3;

export const LIST = LIST_FUNCTION;
export const DETAIL = DETAIL_FUNCTION;
export const STATS = STATS_FUNCTION;
export const UPSTREAM_ORIGIN = ORIGIN;

const publicOperations = new Map<string, 'GET' | 'POST'>([
  [LIST_FUNCTION, 'GET'],
  [DETAIL_FUNCTION, 'POST'],
  [STATS_FUNCTION, 'GET'],
]);

const requestQueue = new PacedRequestQueue(MAX_ACTIVE_REQUESTS, REQUEST_INTERVAL_MS);

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

/**
 * Invoke one pinned public function. The serializer and versioned wire format
 * live in `client-adapter`; this adds the transport contract on top.
 */
export async function callPublicFunction(identifier: string, data: unknown): Promise<unknown> {
  const method = publicOperations.get(identifier);
  if (!method) {
    throw new Error('Unexpected upstream operation');
  }
  return invokePublicFunction(identifier, method, data, publicFetch);
}

/** What the request queue looks like right now, for the health report. */
export function transportMetrics() {
  return requestQueue.metrics();
}
