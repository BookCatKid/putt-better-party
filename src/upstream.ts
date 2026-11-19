/**
 * The upstream surface: a stable facade over the pinned read protocol.
 *
 * Callers import from here, not from the implementation modules, so the split
 * into `upstream/` stays an internal detail. The responsibilities are
 * separated there the way this file's sections already were:
 *
 * - `transport.ts` — the only code that may open a connection to putt.day:
 *   the pinned-function allowlist, the paced request queue and the serializer
 *   adapter.
 * - `catalog.ts` — the community browse plus the listed-course metadata index
 *   behind `publicStats`, `detail` and `preview`.
 * - `detail.ts` — the validated course fetch: `public: true`, matching id and
 *   a specification or it is a refusal.
 * - `preview.ts` — the thumbnail proxy and its cache.
 */
import { transportMetrics } from './upstream/transport.js';
import { catalogMetrics } from './upstream/catalog.js';
import { previewCacheSize } from './upstream/preview.js';

export { browse, publicStats, publicRating, rememberPublicMetadata } from './upstream/catalog.js';
export {
  detail,
  parsePublicCourseDetail,
  UnavailablePublicCourseError,
  type PublicCourseDetail,
} from './upstream/detail.js';
export { preview } from './upstream/preview.js';

/**
 * What the upstream surface looks like right now, for the health report.
 *
 * These are counts and cache sizes rather than per-request detail, so reading
 * this cannot itself grow memory or leak what anybody looked at. No course id,
 * title or author is included: the catalog a client browses is its own
 * business, and a health endpoint is often the least protected surface on a
 * service.
 */
export function upstreamMetrics() {
  return {
    queue: transportMetrics(),
    caches: {
      ...catalogMetrics(),
      previews: previewCacheSize(),
    },
  };
}
