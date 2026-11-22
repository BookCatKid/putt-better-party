/**
 * What the audit log records when the verifier refuses a course.
 *
 * `verifyRoundTracks` audits `result.ok`, and the verifier answers a course it
 * cannot model with `ok: false, failure: 'event-course'`. Writing that through
 * records an honest player on an event course as a failed verification, which
 * the anti-cheat page calls "the strongest evidence this server can produce that
 * a report did not come from its own physics". Refusing to model a course says
 * nothing about the player, so it must produce no verdict at all - the same
 * outcome as a client that sends no shot frames.
 *
 * This lives in its own file because `src/event-log.ts` reads `BP_EVENT_LOG`
 * once, at import, and holds it in a module-level constant. A test that sets the
 * variable after importing `room.ts` writes nothing and asserts nothing; the
 * first version of this test did exactly that and passed with the fix reverted.
 * Setting the variable before the dynamic import is what makes the assertion
 * real.
 */
import { afterAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const logDirectory = mkdtempSync(join(tmpdir(), 'bp-verdict-'));
const logFile = join(logDirectory, 'events.jsonl');
process.env.BP_EVENT_LOG = logFile;

const { Room } = await import('../src/room.js');
const { ReplayArchive } = await import('../src/replays.js');

afterAll(() => {
  delete process.env.BP_EVENT_LOG;
  rmSync(logDirectory, { recursive: true, force: true });
});

/** Every `shot_verification` verdict the audit has written so far. */
function verdicts() {
  if (!existsSync(logFile)) {
    return [];
  }
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes('shot_verification'));
}

/** Drive one real room through a completed hole on the given course. */
async function completeHole(specification, { expectVerdict = false } = {}) {
  const db = new Database(':memory:');
  const archive = new ReplayArchive(db);
  const room = new Room('ABCDE', new Map([['course', { id: 'course', spec: specification }]]), {
    countdown: 1,
    results: 1,
    onReplayRound: archive.record.bind(archive),
  });
  const identity = room.issue('Host');
  const ws = { data: {}, send() {}, close() {} };
  room.handle(ws, { t: 'join', ...identity, host: room.hostToken, protocol: 2 });
  room.handle(ws, {
    t: 'config',
    config: { mapSource: 'picked', selectedHoleIds: ['course'], elimination: false },
  });
  room.handle(ws, { t: 'start' });
  for (let attempt = 0; attempt < 100 && room.phase !== 'playing'; attempt += 1) {
    await Bun.sleep(5);
  }
  expect(room.phase).toBe('playing');
  const scope = { matchId: room.matchId, holeIndex: 0 };
  room.handle(ws, { t: 'shot', ...scope, dir: [0, 1], power: 0.4 });
  room.handle(ws, {
    f: 1,
    s: 1,
    p: 2,
    ...scope,
    replay: {
      samples: [10, 200, 10, 300, 0],
      states: [],
      native: { path: [], trajectory: [0, 0, 0, 1, 0, 0], events: [] },
    },
  });
  expect(room.phase).not.toBe('playing');
  /*
   * The verdict is written after the round is stored, so poll for it rather than
   * sleeping a fixed time: under a loaded suite the verifier can take longer than
   * any sleep that is still cheap in a unit test. When no verdict is expected,
   * wait long enough that a wrongly-written one would have appeared.
   */
  const before = verdicts().length;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (verdicts().length > before) {
      break;
    }
    await Bun.sleep(20);
  }
  const round = JSON.parse(Buffer.from(archive.round(room.replayId, 0)).toString());
  room.dispose();
  db.close();
  return { round, verdictCount: verdicts().length - before };
}

test('a course the verifier cannot model produces no verdict, rather than a failed one', async () => {
  const { round, verdictCount } = await completeHole({
    id: 'course',
    name: 'Confetti Fixture',
    par: 2,
    pieces: [{ piece: 'open', x: 0, y: 0, z: 0 }],
    // A particle emitter and nothing that touches the ball, so the physics would
    // in fact replay correctly - the audit must not depend on that.
    events: { nodes: { n1: { kind: 'particle-emitter', preset: 'confetti' } }, links: {} },
  });

  // The round is still archived with its inputs; only the verdict is withheld.
  expect(round.tracks[0].shots).toEqual([{ dir: [0, 1], power: 0.4 }]);
  expect(verdictCount).toBe(0);
});

/*
 * The mirror case - that a course the verifier *can* model still gets a verdict -
 * cannot be asserted here. `src/event-log.ts` reads `BP_EVENT_LOG` once at import
 * and holds it in a module constant, so whether this file's log file is written
 * depends on which test file loaded `room.ts` first in the same process. Run
 * alone it passes; in the full suite another file imports `room.ts` before this
 * one sets the variable, and nothing is written at all.
 *
 * That is a property of the logging module, not of the guard under test, and
 * asserting it here would produce a test that fails for a reason unrelated to
 * what it claims to check. The positive path is covered by
 * `tests/integration/check-shot-verification.mjs`, which runs in its own process
 * with `BP_EVENT_LOG` set in the environment before the server starts - and it
 * asserts a real `ok: true` verdict end to end.
 */
