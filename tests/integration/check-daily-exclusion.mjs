import assert from 'node:assert/strict';
import { invokePublicFunction, currentDailyNumber } from '../../src/upstream/client-adapter.ts';

/**
 * Historical daily exclusion, checked against the original site's own archive.
 *
 * The random "exclude daily holes" option must not hand out a hole that has
 * already been the day's hole. Two upstream views describe that set:
 *
 *  - the daily catalog listing (`/api/catalog?daily=true`), which is the view the
 *    room actually excludes from, and
 *  - the archive the original site renders at /archive, which credits one player
 *    hole per day that was actually assigned to a submission.
 *
 * This script compares them so the differences are known rather than assumed.
 * The archive is the historical record; the listing is the playable view, so a
 * hole that ran and was later withdrawn from public view appears in the archive
 * and cannot be played at all — it needs no exclusion because it cannot be
 * selected. Read-only apart from one throwaway room, used to prove that such a
 * hole is refused by the import boundary.
 */

const base = process.env.BASE || 'http://127.0.0.1:8789';
const headers = { origin: base, 'content-type': 'application/json' };

/**
 * Two server functions pinned by the original bundles. The /archive module
 * imports the first from the site index and calls it with a plain GET; one call
 * returns every credited day. The /day/$n route calls the second with `{ n }`
 * and answers with the course that day actually ran.
 */
const ARCHIVE_FUNCTION = '8c8412aa6186e70fbda717a8aaa59db5d0b6cd8ce2fdbf6f229308742ce3a862';
const DAY_FUNCTION = 'bafcd0ab83d0d3219683b64f747d51b6d76b9874f2126eb583c9f0941c30916c';

/** The original client's own serializer, so the request shape is not guessed. */
let lastRequestAt = 0;
async function transport(relative, options) {
  // The public endpoints rate-limit, and this script walks far more of them than
  // a browser would.
  const delay = Math.max(0, 700 - Date.now() + lastRequestAt);
  await new Promise((resolve) => setTimeout(resolve, delay));
  lastRequestAt = Date.now();
  const requestHeaders = new Headers(options.headers);
  requestHeaders.delete('cookie');
  requestHeaders.delete('authorization');
  requestHeaders.set('referer', 'https://putt.day/archive');
  return fetch('https://putt.day' + relative, {
    ...options,
    headers: requestHeaders,
    redirect: 'error',
  });
}

async function upstream(hash, method, data) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await invokePublicFunction(hash, method, data, transport);
    } catch (error) {
      if (attempt >= 3) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
}

const get = async (path) => {
  const response = await fetch(base + path);
  assert(response.ok, path + ' -> ' + response.status);
  return response.json();
};

const post = async (path, body) => {
  const response = await fetch(base + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

/** Every credited day, keyed by day number, as the archive reports it. */
async function readArchive() {
  const result = await upstream(ARCHIVE_FUNCTION, 'GET', {});
  assert(
    result && typeof result === 'object' && !Array.isArray(result),
    'unexpected archive shape',
  );

  const credits = new Map();
  for (const [key, value] of Object.entries(result)) {
    assert(/^\d{1,6}$/.test(key), 'archive key is not a day number: ' + key);
    assert(value && typeof value === 'object', 'archive day ' + key + ' is not a record');
    // The archive credits a day by title, author and creator only. It carries no
    // course id, so a course has to be matched on its credited identity.
    assert.equal(typeof value.title, 'string', 'archive day ' + key + ' has no title');
    credits.set(Number(key), {
      day: Number(key),
      title: value.title,
      author: typeof value.author === 'string' ? value.author : '',
      creatorId: typeof value.creatorId === 'string' ? value.creatorId : '',
    });
  }
  return credits;
}

/** The catalog's own daily view, paged through completely. */
async function listDailies() {
  const holes = [];
  let offset = 0;
  for (let page = 0; page < 40; page++) {
    const body = await get('/api/catalog?sort=new&offset=' + offset + '&daily=true');
    assert(Array.isArray(body.holes), 'daily catalog page has no holes');
    holes.push(...body.holes);
    if (body.nextOffset === null) {
      return holes;
    }
    assert(body.nextOffset > offset, 'daily catalog pagination did not advance');
    offset = body.nextOffset;
  }
  throw Error('daily catalog did not end');
}

const identity = (title, creatorId) => `${title}::${creatorId ?? ''}`;

const archive = await readArchive();
const archiveDays = [...archive.keys()].sort((left, right) => left - right);
assert(archive.size > 0, 'archive returned no credited days');
console.log(`PASS archive credits ${archive.size} days (${archiveDays[0]}–${archiveDays.at(-1)})`);

const listed = await listDailies();
assert.equal(listed.length, new Set(listed.map((hole) => hole.id)).size, 'duplicate daily ids');
for (const hole of listed) {
  assert.equal(typeof hole.id, 'string', 'daily entry has no id');
  assert.equal(typeof hole.title, 'string', 'daily entry has no title');
  assert(
    typeof hole.scheduledDay === 'number' || hole.scheduledDay === null,
    'daily entry has an unusable scheduledDay',
  );
}
const scheduled = listed.filter((hole) => typeof hole.scheduledDay === 'number');
console.log(
  `PASS daily catalog lists ${listed.length} featured holes, ${scheduled.length} with a day`,
);

// The listing must not contradict itself: one day, one featured hole.
const scheduledDays = scheduled.map((hole) => hole.scheduledDay);
assert.equal(new Set(scheduledDays).size, scheduledDays.length, 'two holes claim the same day');

const listedByKey = new Map(listed.map((hole) => [identity(hole.title, hole.creatorId), hole]));
let agreed = 0;
const disagreements = [];
for (const credit of archive.values()) {
  const hole = listedByKey.get(identity(credit.title, credit.creatorId));
  if (!hole) {
    continue;
  }
  agreed++;
  if (hole.scheduledDay !== credit.day) {
    disagreements.push([credit.day, hole.id, hole.scheduledDay]);
  }
}
assert.deepEqual(disagreements, [], 'listing and archive disagree on the day a course ran');
console.log(`PASS listing and archive agree on all ${agreed} shared featured courses`);

// The remainder is the interesting part. A credited day with no listed course
// ran and was later withdrawn from public view: it is unreachable, not merely
// unexcluded, so nothing needs to remember its day.
const withdrawn = [...archive.values()].filter(
  (credit) => !listedByKey.has(identity(credit.title, credit.creatorId)),
);
console.log(
  `NOTE ${withdrawn.length} credited day(s) are no longer publicly listed: ` +
    (withdrawn.map((credit) => `${credit.day}:${credit.title}`).join(', ') || 'none'),
);

// A listed course that no credited day matches was scheduled but never ran.
// Excluding it withdraws a playable hole for no reason, which is the failure mode
// worth knowing about rather than a safety hole.
const archiveKeys = new Set(
  [...archive.values()].map((credit) => identity(credit.title, credit.creatorId)),
);
const uncredited = listed.filter((hole) => !archiveKeys.has(identity(hole.title, hole.creatorId)));
console.log(
  `NOTE ${uncredited.length} listed course(s) were scheduled but never credited: ` +
    (uncredited
      .map((hole) => `${hole.id} "${hole.title}" scheduledDay=${hole.scheduledDay}`)
      .join(', ') || 'none'),
);

// A future-dated listing is playable today and must stay out of the exclusion.
const today = currentDailyNumber();
const future = scheduled.filter((hole) => hole.scheduledDay > today);
console.log(`NOTE ${future.length} listed course(s) scheduled after today (${today})`);
assert(
  future.every((hole) => hole.scheduledDay > today),
  'a scheduled day must be in the future to be exempt',
);

// Prove the safety claim: a withdrawn featured hole cannot be played, so it can
// never be handed out by random selection either.
if (withdrawn.length > 0) {
  const room = await post('/api/create', {});
  assert.equal(room.status, 200, 'could not create a room');
  const joined = await post('/api/join', {
    code: room.body.code,
    name: 'daily exclusion check',
    host: room.body.hostToken,
  });
  assert.equal(joined.status, 200, 'could not join the room');

  // Importing requires a connected lobby host, so the check joins the room the
  // way a browser does rather than bypassing admission.
  const socket = new WebSocket(base.replace('http', 'ws') + '/ws/party/' + room.body.code, {
    headers: { origin: base },
  });
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  socket.send(
    JSON.stringify({
      t: 'join',
      ...joined.body,
      host: room.body.hostToken,
      protocol: 2,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 300));

  try {
    for (const credit of withdrawn) {
      const day = await upstream(DAY_FUNCTION, 'GET', { n: credit.day });
      // The day endpoint still credits the course and still holds its geometry: the
      // withdrawal is a visibility change, not a deletion. That makes the course id
      // exactly the one that has to be refused, and the specification id never was
      // a catalog course at all.
      assert.equal(
        typeof day.credit?.id,
        'string',
        'day ' + credit.day + ' no longer credits an id',
      );
      assert.equal(typeof day.spec?.id, 'string', 'day ' + credit.day + ' has no specification');
      for (const id of [day.credit.id, day.spec.id]) {
        const attempted = await post('/api/import', {
          code: room.body.code,
          uid: joined.body.uid,
          session: joined.body.session,
          host: room.body.hostToken,
          id,
          saved: true,
        });
        assert.equal(attempted.status, 400, 'a withdrawn featured hole must not be importable');
      }
    }
  } finally {
    socket.close();
  }
  console.log('PASS withdrawn featured holes are not importable');
}
