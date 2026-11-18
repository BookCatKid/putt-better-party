import {
  MAP_SOURCE,
  type CatalogEntry,
  type CourseIndex,
  type PreparedMatch,
  type PublicCourse,
  type RoomConfig,
} from './domain.js';
import { browse, detail } from './upstream.js';
import { currentDailyNumber, validateCourse } from './upstream/client-adapter.js';
import { chooseRandom } from './random-selection.js';

/**
 * Process-local course index. The backing map is not publicly mutable.
 * Restored rooms may register metadata; playable specifications are only
 * inserted by fetchPublicMap after fetching and validating the public detail.
 */
const courseEntries = new Map<string, CatalogEntry>();
export const courseIndex: CourseIndex = {
  get: (id) => courseEntries.get(id),
  has: (id) => courseEntries.has(id),
  keys: () => courseEntries.keys(),
  set: (id, entry) => {
    // Only room recovery uses this method: never replace a validated course.
    if (!courseEntries.has(id)) {
      courseEntries.set(id, { id, title: entry.title });
    }
  },
};
export function courseCount(): number {
  return courseEntries.size;
}

async function retrievePublicMap(id: string, options?: { saved?: boolean }): Promise<PublicCourse> {
  const mapDetail = await detail(id, options);
  const specification = validateCourse(mapDetail.spec, mapDetail.title);

  return {
    id: mapDetail.id,
    title: mapDetail.title,
    author: mapDetail.author || '',
    par: specification.par,
    spec: specification,
  };
}

export async function fetchPublicMap(
  id: string,
  options?: { saved?: boolean },
): Promise<PublicCourse> {
  const course = await retrievePublicMap(id, options);
  courseEntries.set(id, course);
  return course;
}

export async function prepareMatch(
  config: RoomConfig,
  seen: string[] = [],
): Promise<PreparedMatch> {
  let selectedIds = config.selectedHoleIds.slice();
  let nextHistory = seen;

  if (config.mapSource === MAP_SOURCE.RANDOM) {
    const selection = await chooseRandom({
      browse,
      count: config.holes,
      seen,
      excludeDaily: config.excludeDaily,
      currentDay: currentDailyNumber(),
    });
    selectedIds = selection.ids;
    nextHistory = selection.seen;
  }

  // Manual playlists load future holes on demand; the random playlist is bounded.
  const manual = config.mapSource === MAP_SOURCE.PICKED;
  const initialIds = manual ? selectedIds.slice(0, 1) : selectedIds;
  // The request queue limits concurrency globally. Wait for every required
  // detail and retain the selected order even when responses finish out of
  // order. A refused course still aborts preparation before a match starts.
  const results = await Promise.allSettled(
    initialIds.map((id) => retrievePublicMap(id, { saved: manual })),
  );
  const specifications = [];
  for (const result of results) {
    if (result.status === 'rejected') {
      throw result.reason;
    }
    const course = result.value;
    courseEntries.set(course.id, course);
    specifications.push(structuredClone(course.spec));
  }

  return { ids: selectedIds, specs: specifications, seen: nextHistory };
}
