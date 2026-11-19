import { test, expect } from 'bun:test';
import { bpHistoryJson, bpResultsCsv } from '../scripts/results-export.js';

/**
 * Shareable results.
 *
 * Two properties matter. The file must say what the screen said, so a shared
 * scorecard is not a second, differently-derived version of the result. And it must
 * carry nothing private: no uid, session, host token, connection id or course
 * specification. The first is checked against the same structures the scorecard
 * renders; the second is checked directly against the serialised text.
 */

const round = (index, overrides = {}) => ({
  index,
  id: 'course-' + index,
  title: 'Course ' + index,
  par: 3,
  status: 'completed',
  rows: [],
  ...overrides,
});

const player = (uid, name, totalStrokes, overrides = {}) => ({
  uid,
  name,
  rank: 1,
  holesSurvived: 1,
  totalStrokes,
  totalTimeMs: 1000,
  alive: true,
  connected: true,
  hue: 200,
  ball: 'baseball',
  ...overrides,
});

test('a CSV scorecard has the course, par, each hole and the totals', () => {
  const history = [
    round(0, {
      rows: [
        { uid: 'uid-a', strokes: 2, status: 'holed', timeMs: 1000 },
        { uid: 'uid-b', strokes: 4, status: 'holed', timeMs: 2000 },
      ],
    }),
    round(1, {
      title: 'Second course',
      par: 4,
      rows: [
        { uid: 'uid-a', strokes: 5, status: 'timeout', timeMs: 5000 },
        { uid: 'uid-b', strokes: 3, status: 'holed', timeMs: 3000 },
      ],
    }),
  ];
  const standings = [player('uid-a', 'Alpha', 7), player('uid-b', 'Bravo', 7, { rank: 2 })];
  const lines = bpResultsCsv(history, standings).trim().split('\r\n');
  expect(lines).toEqual([
    'Hole,1,2,Total,To par',
    'Course,Course 0,Second course,,',
    'Par,3,4,,',
    // Alpha: 2 + 5 = 7 against 3 + 4 = 7, so level par.
    'Alpha,2,5,7,E',
    'Bravo,4,3,7,E',
  ]);
});

test('every named state is spelled the way the scorecard spells it', () => {
  const history = [
    round(0, { status: 'skipped', rows: [] }),
    round(1, { rows: [{ uid: 'uid-a', strokes: null, status: 'eliminated' }] }),
    round(2, { status: 'ended', rows: [{ uid: 'uid-a', strokes: null, status: 'ended' }] }),
    round(3, { rows: [{ uid: 'uid-a', strokes: 3, status: 'timeout', timeMs: 100 }] }),
  ];
  const standings = [player('uid-a', 'Alpha', 3)];
  const rows = bpResultsCsv(history, standings).trim().split('\r\n');
  // Only the timeout hole was scored, and it was par, so the figure is level par -
  // a skipped hole, an elimination and an ended row contribute no par to compare.
  expect(rows.at(-1)).toBe('Alpha,Skip,DNF,End,3,3,E');
});

test('a relative-to-par figure uses the par of the holes actually scored', () => {
  // Eliminated on the first hole and never scored: no par faced, so no figure.
  const history = [round(0, { rows: [{ uid: 'uid-a', strokes: null, status: 'eliminated' }] })];
  const rows = bpResultsCsv(history, [player('uid-a', 'Alpha', 0)])
    .trim()
    .split('\r\n');
  expect(rows.at(-1)).toBe('Alpha,DNF,0,');
});

test('course names with commas and quotes stay one field', () => {
  const history = [
    round(0, {
      title: 'Windy, "the" course',
      rows: [{ uid: 'uid-a', strokes: 1, status: 'holed' }],
    }),
  ];
  const csv = bpResultsCsv(history, [player('uid-a', 'Alpha', 1)]);
  expect(csv).toContain('"Windy, ""the"" course"');
  // The quoting is structural, not cosmetic: the row still has five fields.
  const courseLine = csv.split('\r\n')[1];
  expect(courseLine.startsWith('Course,"Windy, ""the"" course",,')).toBe(true);
});

test('the CSV carries no credential or cosmetic', () => {
  const history = [
    round(0, {
      rows: [{ uid: 'uid-secret', strokes: 2, status: 'holed', timeMs: 1000 }],
    }),
  ];
  const csv = bpResultsCsv(history, [player('uid-secret', 'Alpha', 2)]);
  for (const forbidden of ['uid', 'session', 'token', 'hue', 'ball', 'spec', 'levelId']) {
    expect(csv.toLowerCase()).not.toContain(forbidden);
  }
});

test('a team row sums its members and expands to the team total', () => {
  const history = [
    round(0, {
      rows: [
        { uid: 'uid-a', strokes: 2, status: 'holed', timeMs: 1000 },
        { uid: 'uid-b', strokes: 3, status: 'holed', timeMs: 2000 },
        { uid: 'uid-c', strokes: 4, status: 'holed', timeMs: 3000 },
      ],
    }),
  ];
  // Team 1 is a+b, Team 2 is c alone, as the server would send them.
  const teams = [
    { id: 'team-1', name: 'Team 1', hue: 205, members: ['uid-a', 'uid-b'] },
    { id: 'team-2', name: 'Team 2', hue: 25, members: ['uid-c'] },
  ];
  const standings = [
    { ...player('team-1', 'Team 1', 5), rank: 1 },
    { ...player('team-2', 'Team 2', 4), rank: 2 },
  ];
  const rows = bpResultsCsv(history, standings, teams).trim().split('\r\n');
  expect(rows.at(-2)).toBe('Team 1,5,5,+2');
  expect(rows.at(-1)).toBe('Team 2,4,4,+1');
  // And the file still names no uid.
  expect(bpResultsCsv(history, standings, teams)).not.toContain('uid-');
});

test('an empty or absent match produces no file rather than a header-only one', () => {
  expect(bpResultsCsv([], [])).toBe('');
  expect(bpResultsCsv(undefined, undefined)).toBe('');
  expect(bpResultsCsv([round(0)], [])).toBe('');
});

test('history JSON is versioned, projected and free of internal ids', () => {
  const history = [
    {
      matchId: 'match-internal-id',
      endedAt: 1700000000000,
      holes: 2,
      courses: [
        { id: 'course-0', title: 'Course 0', par: 3, spec: { secret: true }, geometry: '...' },
      ],
      standings: [
        {
          name: 'Alpha',
          rank: 1,
          holesSurvived: 2,
          totalStrokes: 5,
          totalTimeMs: 4000,
          uid: 'uid-secret',
          session: 'session-secret',
        },
      ],
      extra: 'not exported',
    },
  ];
  const parsed = JSON.parse(bpHistoryJson(history));
  expect(parsed).toEqual({
    format: 'better-party.results',
    version: 1,
    matches: [
      {
        endedAt: 1700000000000,
        holes: 2,
        courses: [{ id: 'course-0', title: 'Course 0', par: 3 }],
        standings: [
          {
            name: 'Alpha',
            rank: 1,
            holesSurvived: 2,
            totalStrokes: 5,
            totalTimeMs: 4000,
          },
        ],
      },
    ],
  });
  const text = bpHistoryJson(history);
  for (const forbidden of ['uid', 'session', 'token', 'spec', 'geometry', 'matchId']) {
    expect(text).not.toContain(forbidden);
  }
});

test('history JSON is valid with no matches', () => {
  expect(JSON.parse(bpHistoryJson([]))).toEqual({
    format: 'better-party.results',
    version: 1,
    matches: [],
  });
  expect(JSON.parse(bpHistoryJson(undefined)).matches).toEqual([]);
});
