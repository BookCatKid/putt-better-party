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

export async function fetchPublicMap(
  id: string,
  options?: { saved?: boolean },
): Promise<PublicCourse> {
  const mapDetail = await detail(id, options);
  const specification = validateCourse(mapDetail.spec, mapDetail.title);

  const course: PublicCourse = {
    id: mapDetail.id,
    title: mapDetail.title,
    author: mapDetail.author || '',
    par: specification.par,
    spec: specification,
  };
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
  const fetchedCourses = new Map<string, PublicCourse>();
  const specifications = [];

  for (const id of initialIds) {
    let course = fetchedCourses.get(id);
    if (!course) {
      course = await fetchPublicMap(id, { saved: manual });
      fetchedCourses.set(id, course);
    }
    specifications.push(structuredClone(course.spec));
  }

  return { ids: selectedIds, specs: specifications, seen: nextHistory };
}
