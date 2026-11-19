/**
 * Course detail: the validated fetch that makes a public course playable.
 *
 * The boundary rule lives here and nowhere else: a detail response is accepted
 * only when upstream itself calls it public, names the course that was asked
 * for and carries a specification. `parsePublicCourseDetail` is kept separate
 * from the network call so the rule can be exercised directly, and concurrent
 * imports of the same course share one upstream request.
 */
import { isRecord } from '../domain.js';
import { DETAIL, callPublicFunction } from './transport.js';
import { isListedCourse, listedCourse, rememberListed } from './catalog.js';

export interface PublicCourseDetail {
  id: string;
  title: string;
  author: string;
  spec: unknown;
}

export class UnavailablePublicCourseError extends Error {
  constructor(readonly courseId: string) {
    super('Map is unavailable or not public');
  }
}

/**
 * The acceptance rule for a detail response. `public: true`, the same id and a
 * specification or it is a refusal — never a fallback to locally stored
 * geometry.
 */
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
 * Two rooms importing the same course at the same time used to make two
 * upstream requests for identical data. Sharing the promise is safe because
 * the response is immutable and the per-call validation above still runs
 * first, so a `saved: true` caller and a plain caller each get the answer they
 * are entitled to.
 *
 * The map is bounded by the fetch queue, not by the catalogue: an entry exists
 * only while its request does, and a request that cannot be admitted is
 * refused before it ever reaches here.
 */
const inflightDetails = new Map<string, Promise<PublicCourseDetail>>();

export async function detail(
  id: string,
  { saved = false }: { saved?: boolean } = {},
): Promise<PublicCourseDetail> {
  if (
    typeof id !== 'string' ||
    (!isListedCourse(id) && !(saved && /^[a-zA-Z0-9_-]{5,64}$/.test(id)))
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
      await callPublicFunction(DETAIL, { id }),
      listedCourse(id),
    );
    if (!isListedCourse(id)) {
      rememberListed({ id, title: course.title, author: course.author });
    }
    return course;
  })();
  inflightDetails.set(id, promise);
  // Both outcomes clear the entry. Attaching a handler for the rejection as
  // well as the resolution keeps this bookkeeping from surfacing as an
  // unhandled rejection.
  const forget = () => {
    if (inflightDetails.get(id) === promise) {
      inflightDetails.delete(id);
    }
  };
  promise.then(forget, forget);
  return promise;
}
