/**
 * Compare what the server predicted against what the client recorded.
 *
 * An operator tool, not a test: it reads an archived round out of the room
 * database, replays each recorded shot through the same physics the server
 * audits with, and prints the two trajectories side by side. `bun run check`
 * never runs it, and it needs a database that has had a round played into it.
 *
 * The comparison is deliberately reported two ways, because they answer
 * different questions:
 *
 *  - **Path deviation** — for every point the client recorded, how far is it
 *    from the nearest point on the replayed path? This is what the verifier
 *    enforces, and it is stable regardless of how many samples each side took.
 *  - **Index alignment** — sample `i` against sample `i`. This is what "exact"
 *    would mean, and it is *not* expected to hold: the client samples once per
 *    rendered frame and resets its accumulator on every sample, so its spacing
 *    is `ceil(0.04 / frameDelta) * frameDelta` rather than 0.04 s. Two runs at
 *    different frame rates record different sample counts of the same path.
 *
 * Usage:
 *   bun scripts/compare-replay.mjs --db state/rooms.sqlite
 *   bun scripts/compare-replay.mjs --db state/rooms.sqlite --match <id> --hole 0
 *   bun scripts/compare-replay.mjs --db state/rooms.sqlite --all
 *
 * Options:
 *   --db <path>       Room database holding `replay_rounds` (required)
 *   --match <id>      Only this match id
 *   --hole <n>        Only this hole index
 *   --all             Print every sample, not just the interesting ones
 *   --samples <n>     Print at most this many sample rows (default 30)
 */
import { Database } from 'bun:sqlite';
import { gunzipSync } from 'node:zlib';
import { buildCourseGeometry } from '../src/replay/course-geometry.js';
import { preparedModelLoader } from '../src/replay/models.js';
import { loadPhysics, replayShot } from '../src/replay/simulate.js';
import { PATH_TOLERANCE_CM, unverifiableReason } from '../src/replay/verify.js';

function parseArguments(argv) {
  const options = { db: null, match: null, hole: null, all: false, samples: 30 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--db') {
      options.db = value;
      index += 1;
    } else if (flag === '--match') {
      options.match = value;
      index += 1;
    } else if (flag === '--hole') {
      options.hole = Number(value);
      index += 1;
    } else if (flag === '--all') {
      options.all = true;
    } else if (flag === '--samples') {
      options.samples = Number(value);
      index += 1;
    } else if (flag === '--help' || flag === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return options;
}

const usage = `
Compare the server's replay against the client's recorded trajectory.

  bun scripts/compare-replay.mjs --db <path> [--match <id>] [--hole <n>] [--all] [--samples <n>]

Reads an archived round from the room database, replays each recorded shot
through the pinned Rapier build, and prints the two trajectories side by side
with the path deviation the verifier enforces.
`.trim();

/** Distance from a point to the nearest point on a path, in centimetres. */
function pointToPathCm(pointX, pointY, pointZ, path) {
  let best = Infinity;
  for (let at = 0; at + 2 < path.length; at += 3) {
    const distance = Math.hypot(path[at] - pointX, path[at + 1] - pointY, path[at + 2] - pointZ);
    if (distance < best) {
      best = distance;
    }
  }
  return best;
}

/** Read every archived round that has both shot inputs and a recorded path. */
function readableRounds(db, options) {
  const rounds = db
    .query('SELECT match_id, hole, payload FROM replay_rounds ORDER BY rowid DESC')
    .all();
  const found = [];
  for (const row of rounds) {
    if (options.match && row.match_id !== options.match) {
      continue;
    }
    if (options.hole !== null && row.hole !== options.hole) {
      continue;
    }
    let round;
    try {
      // `node:zlib` rather than `Bun.gunzipSync`: the latter returns a
      // `Uint8Array`, whose `toString()` is a comma-joined list of byte values
      // rather than text, so `JSON.parse` fails with a message that suggests
      // corrupt data instead of a wrong API.
      round = JSON.parse(gunzipSync(Buffer.from(row.payload)).toString('utf8'));
    } catch {
      continue;
    }
    for (const track of round.tracks ?? []) {
      const reported = track.native?.trajectory;
      if (track.status !== 'holed' || !track.shots?.length || !Array.isArray(reported)) {
        continue;
      }
      if (!reported.length) {
        continue;
      }
      found.push({ matchId: row.match_id, hole: row.hole, round, track, reported });
    }
  }
  return found;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  if (!options.db) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }

  const db = new Database(options.db, { readonly: true });
  try {
    const candidates = readableRounds(db, options);
    if (!candidates.length) {
      console.error(
        'No archived round has both recorded shot inputs and a recorded trajectory.\n' +
          'Play a hole on a course the verifier models, then run this again.',
      );
      process.exitCode = 1;
      return;
    }

    const engine = await loadPhysics();
    for (const candidate of candidates) {
      const { round, track, reported, matchId, hole } = candidate;
      const level = round.level;
      console.log('');
      console.log(`match ${matchId}  hole ${hole}  player ${track.name}`);
      console.log(`course ${level?.name ?? '(unknown)'}  par ${level?.par ?? '?'}`);
      console.log(`client reported ${reported.length / 3} samples, ${track.shots.length} shot(s)`);

      const refusal = level ? unverifiableReason(level) : 'no course specification archived';
      if (refusal) {
        console.log(`not verified: ${refusal}`);
        continue;
      }

      let geometry;
      try {
        geometry = buildCourseGeometry(level, preparedModelLoader());
      } catch (error) {
        console.log(`no geometry: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      // Each shot starts where the previous one came to rest, so the replayed
      // path is the concatenation of every stroke in the hole.
      let spawn;
      let trajectory = [];
      let holed = false;
      for (const shot of track.shots) {
        const outcome = replayShot(engine, { geometry, shot, spawn });
        trajectory = trajectory.concat(outcome.trajectory);
        holed = outcome.holed;
        spawn = [outcome.rest.x, outcome.rest.y - 0.06, outcome.rest.z];
        if (holed) {
          break;
        }
      }

      console.log(`replayed ${trajectory.length / 3} samples, holed ${holed}`);
      console.log('');

      // Path deviation: what the verifier actually enforces.
      let worst = 0;
      let worstAt = -1;
      for (let at = 0; at + 2 < reported.length; at += 3) {
        const deviation = pointToPathCm(
          reported[at],
          reported[at + 1],
          reported[at + 2],
          trajectory,
        );
        if (deviation > worst) {
          worst = deviation;
          worstAt = at / 3;
        }
      }
      console.log('PATH DEVIATION (what the verifier enforces)');
      console.log(`  worst point-to-path: ${worst.toFixed(2)} cm at client sample ${worstAt}`);
      console.log(`  tolerance:           ${PATH_TOLERANCE_CM} cm`);
      console.log(
        `  verdict:             ${worst <= PATH_TOLERANCE_CM ? 'inside tolerance' : 'OUTSIDE TOLERANCE'}`,
      );
      console.log('');

      // Index alignment: what "exact" would mean, and why it does not hold.
      const clientCount = reported.length / 3;
      const replayCount = trajectory.length / 3;
      console.log('INDEX ALIGNMENT (sample i against sample i)');
      console.log(`  client samples: ${clientCount}`);
      console.log(`  replay samples: ${replayCount}`);
      if (clientCount !== replayCount) {
        console.log(
          `  counts differ by ${Math.abs(clientCount - replayCount)}: the client samples once per`,
        );
        console.log(
          '  rendered frame and resets its accumulator on every sample, so its spacing is',
        );
        console.log('  ceil(0.04 / frameDelta) * frameDelta rather than 0.04 s. This is expected.');
      }
      const shared = Math.min(clientCount, replayCount);
      let worstAligned = 0;
      let worstAlignedAt = -1;
      for (let index = 0; index < shared; index += 1) {
        const delta = Math.hypot(
          reported[index * 3] - trajectory[index * 3],
          reported[index * 3 + 1] - trajectory[index * 3 + 1],
          reported[index * 3 + 2] - trajectory[index * 3 + 2],
        );
        if (delta > worstAligned) {
          worstAligned = delta;
          worstAlignedAt = index;
        }
      }
      console.log(
        `  worst index-aligned delta: ${worstAligned.toFixed(2)} cm at sample ${worstAlignedAt}`,
      );
      console.log('');

      console.log('  index   client (x,y,z cm)      replay (x,y,z cm)      delta cm');
      const rows = [];
      for (let index = 0; index < Math.max(clientCount, replayCount); index += 1) {
        const hasClient = index < clientCount;
        const hasReplay = index < replayCount;
        const client = hasClient
          ? [reported[index * 3], reported[index * 3 + 1], reported[index * 3 + 2]]
          : null;
        const replay = hasReplay
          ? [trajectory[index * 3], trajectory[index * 3 + 1], trajectory[index * 3 + 2]]
          : null;
        const delta =
          client && replay
            ? Math.hypot(...client.map((value, axis) => value - replay[axis]))
            : null;
        rows.push({ index, client, replay, delta });
      }
      const showAll = options.all || rows.length <= options.samples;
      const step = showAll ? 1 : Math.ceil(rows.length / options.samples);
      for (const row of rows) {
        const interesting =
          row.index < 5 ||
          row.index >= rows.length - 5 ||
          (row.delta !== null && row.delta >= 2) ||
          row.index === worstAlignedAt;
        if (!showAll && !interesting && row.index % step !== 0) {
          continue;
        }
        const clientText = row.client
          ? `${String(row.client[0]).padStart(5)},${String(row.client[1]).padStart(4)},${String(row.client[2]).padStart(5)}`
          : '        (none)       ';
        const replayText = row.replay
          ? `${String(row.replay[0]).padStart(5)},${String(row.replay[1]).padStart(4)},${String(row.replay[2]).padStart(5)}`
          : '        (none)       ';
        const deltaText = row.delta === null ? '     -' : row.delta.toFixed(2).padStart(6);
        console.log(
          `  ${String(row.index).padStart(5)}   ${clientText}   ${replayText}   ${deltaText}`,
        );
      }
    }
  } finally {
    db.close();
  }
}

await main();
