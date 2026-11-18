import {
  MAP_SOURCE,
  type CatalogEntry,
  type CourseIndex,
  type PreparedMatch,
  type PublicCourse,
  type RoomConfig,
} from './domain.js';
import { browse, detail, publicRating, UnavailablePublicCourseError } from './upstream.js';
import { currentDailyNumber, validateCourse } from './upstream/client-adapter.js';
import { chooseRandom, featuredDailyIds } from './random-selection.js';

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
    ...publicRating(id),
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
  const voting = config.mapSource === MAP_SOURCE.RANDOM && config.courseVoting;
  const manual = config.mapSource === MAP_SOURCE.PICKED;
  let selectedIds = config.selectedHoleIds.slice();
  let nextHistory = seen;
  const specifications: PublicCourse[] = [];

  if (manual) {
    // Picked courses are explicit choices: never silently substitute one.
    for (const id of selectedIds.slice(0, 1)) {
      specifications.push(await retrievePublicMap(id, { saved: true }));
    }
  } else {
    const count = voting ? 3 * config.holes : config.holes;
    const currentDay = currentDailyNumber();
    const featuredIds = config.excludeDaily
      ? await featuredDailyIds(browse, currentDay)
      : undefined;
    const omittedIds = new Set<string>();
    const unavailableIds = new Set<string>();
    // Keep successful candidates, and draw replacements only for refused
    // details. A network/protocol outage still fails instead of hammering
    // the service. The daily filter is evaluated just once for this match.
    for (let attempt = 0; specifications.length < count; attempt++) {
      if (attempt >= 8) {
        throw new Error('Not enough available public courses; try a smaller match');
      }
      const selection = await chooseRandom({
        browse,
        count: count - specifications.length,
        seen: nextHistory,
        excludeDaily: config.excludeDaily,
        currentDay,
        featuredIds,
        omittedIds,
      });
      nextHistory = selection.seen;
      // Bound pending detail requests even for large typed hole counts.
      for (let offset = 0; offset < selection.ids.length; offset += 24) {
        const results = await Promise.allSettled(
          selection.ids.slice(offset, offset + 24).map((id) => retrievePublicMap(id)),
        );
        for (const [index, result] of results.entries()) {
          const id = selection.ids[offset + index];
          omittedIds.add(id);
          if (result.status === 'fulfilled') {
            specifications.push(result.value);
          } else if (result.reason instanceof UnavailablePublicCourseError) {
            unavailableIds.add(id);
            console.warn('Skipping unavailable random course:', id);
          } else {
            throw result.reason;
          }
        }
      }
      nextHistory = [
        ...new Set([
          ...nextHistory.filter((id) => !unavailableIds.has(id)),
          ...specifications.map((course) => course.id),
        ]),
      ];
    }
    selectedIds = specifications.map((course) => course.id);
  }
  // Publish only after the complete set of validated courses is available.
  for (const course of specifications) {
    courseEntries.set(course.id, course);
  }

  if (voting) {
    const ballots = Array.from({ length: config.holes }, (_unused, index) =>
      specifications.slice(index * 3, index * 3 + 3),
    );
    return {
      ids: ballots.map((choices) => choices[0].id),
      specs: ballots.map((choices) => structuredClone(choices[0].spec)),
      ballots,
      seen: nextHistory,
    };
  }
  return {
    ids: selectedIds,
    specs: specifications.map((course) => structuredClone(course.spec)),
    seen: nextHistory,
  };
}
