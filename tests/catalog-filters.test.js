import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The catalogue query must stay inside what upstream actually accepts.
 *
 * The browse function is recovered from the pinned client, so its option names are
 * a contract rather than a design choice. Inventing a plausible-looking field such
 * as `par` would not error - upstream would ignore it and return unfiltered results,
 * which is the worst kind of failure because the UI would look like it worked. These
 * tests read both sources and compare them, so adding a field to the client without
 * adding it to the recovered call fails here.
 */

const root = path.resolve(import.meta.dir, '..');
const pickerSource = readFileSync(path.join(root, 'scripts/picker.js'), 'utf8');
// The catalogue query and the card's maker link live in the catalogue module.
const catalogSource = readFileSync(path.join(root, 'scripts/picker-catalog.js'), 'utf8');
const upstreamSource = readFileSync(path.join(root, 'src/upstream.ts'), 'utf8');

/** The keys the client puts on the catalogue query string. */
function clientQueryKeys() {
  const start = catalogSource.indexOf('const params = (offset) =>');
  expect(start).toBeGreaterThan(-1);
  const body = catalogSource.slice(start, catalogSource.indexOf('});', start));
  const keys = [];
  for (const line of body.split('\n')) {
    // Handles both `offset: String(offset),` and the shorthand `search,`.
    const match = /^([a-zA-Z]+)(?::|,)/.exec(line.trim());
    if (match) {
      keys.push(match[1]);
    }
  }
  return keys.sort();
}

/** The keys the recovered browse function forwards to the public call. */
function upstreamOptionKeys() {
  const start = upstreamSource.indexOf('export async function browse(');
  expect(start).toBeGreaterThan(-1);
  const body = upstreamSource.slice(start, upstreamSource.indexOf('const key =', start));
  return [...body.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((match) => match[1]).sort();
}

test('the client sends only fields the recovered browse function accepts', () => {
  const accepted = new Set(upstreamOptionKeys());
  for (const key of clientQueryKeys()) {
    expect(accepted.has(key)).toBe(true);
  }
  // The interesting half: nothing the API cannot filter is being sent.
  expect(clientQueryKeys()).not.toContain('par');
});

test('the client sends every filter the catalogue actually supports', () => {
  // A supported filter that is never sent is dead UI; this pins the set so removing
  // one from the query is a visible change rather than a quiet loss.
  expect(clientQueryKeys()).toEqual(['author', 'daily', 'minRating', 'offset', 'search', 'sort']);
});

test('the sort options offered are the ones the API ranks by', () => {
  // Recovered: `sort: ['new', 'trending', 'top'].includes(sort) ? sort : 'new'`.
  const accepted = upstreamSource.match(
    /sort: \['([a-z]+)', '([a-z]+)', '([a-z]+)'\]\.includes\(sort\)/,
  );
  expect(accepted).not.toBeNull();
  const allowed = new Set([accepted[1], accepted[2], accepted[3]]);

  const offered = [...pickerSource.matchAll(/\['([a-z]+)', '([A-Z][^']*)'\]/g)].map(
    (match) => match[1],
  );
  const sortButtons = ['new', 'trending', 'top'];
  for (const sort of sortButtons) {
    expect(allowed.has(sort)).toBe(true);
  }
  // Nothing outside the ranking list is offered as a sort.
  for (const sort of offered.filter((candidate) => sortButtons.includes(candidate))) {
    expect(allowed.has(sort)).toBe(true);
  }
});

test('the rating filter offers only the thresholds the API accepts', () => {
  // Recovered: `minRating: [3, 4].includes(rating) ? rating : undefined`, so 0 means
  // "no threshold" and any other value would be silently dropped upstream.
  const accepted = upstreamSource.match(/minRating: \[(\d+), (\d+)\]\.includes\(rating\)/);
  expect(accepted).not.toBeNull();
  const thresholds = [Number(accepted[1]), Number(accepted[2])];

  const offered = [...pickerSource.matchAll(/\[(\d+), '[^']*rating'\]/g)].map((match) =>
    Number(match[1]),
  );
  expect(offered).toContain(0);
  for (const threshold of offered.filter((candidate) => candidate !== 0)) {
    expect(thresholds).toContain(threshold);
  }
});

test('the creator filter sends the creator id, as the original client does', () => {
  // Recovered from the pinned gallery: `author: <creator>.id`. Sending a display
  // name would return nothing, and would look like "this maker has no courses".
  expect(catalogSource).toContain('author: maker?.id ??');
  // The card calls its callback with the same shape the filter state expects,
  // and the component binds that callback to setMaker.
  expect(catalogSource).toContain('onMaker({ id: course.creatorId, name: course.author })');
  expect(pickerSource).toContain('onMaker: setMaker');
});
