import {
  a as validate,
  r as sanitize,
} from '../private-client/validation/specValidation-vqop-JBL.js';
import { browse, detail } from './upstream.js';
import { a as dailyNumber } from '../private-client/assets/date-D4dx3Sc1.js';
import { chooseRandom } from './random-selection.js';
// Metadata and validated specifications for the current process only.
// No bundled, user-exported, or disk-cached courses.
export const maps = new Map();
export async function fetchPublicMap(id, options) {
  const d = await detail(id, options);
  if (!d.spec || typeof d.spec !== 'object' || Array.isArray(d.spec))
    throw Error('Missing public map specification');
  const spec = sanitize(structuredClone({ ...d.spec, name: d.title }));
  validate(spec);
  const item = { id: d.id, title: d.title, author: d.author || '', par: spec.par, spec };
  maps.set(id, item);
  return item;
}
export async function prepareMatch(config, seen = []) {
  let ids = config.selectedHoleIds.slice(),
    nextSeen = seen;
  if (config.mapSource === 'random') {
    const chosen = await chooseRandom({
      browse,
      count: config.holes,
      seen,
      excludeDaily: config.excludeDaily,
      currentDay: dailyNumber(new Date()),
    });
    ids = chosen.ids;
    nextSeen = chosen.seen;
  }
  // Fetch the first map immediately; subsequent manual playlist maps are
  // fetched just before use. Random playlists retain the small bounded prefetch.
  const chosen = [],
    unique = new Map();
  for (const id of config.mapSource === 'picked' ? ids.slice(0, 1) : ids) {
    if (!unique.has(id))
      unique.set(id, await fetchPublicMap(id, { saved: config.mapSource === 'picked' }));
    chosen.push(unique.get(id));
  }
  return { ids, specs: chosen.map((x) => structuredClone(x.spec)), seen: nextSeen };
}
