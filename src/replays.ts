import { replayBallColor } from './ball-cosmetics.js';
/** Replay-only archive. No client-supplied course geometry or player credentials
 * enter the public replay. Courses are snapshots of the actual played level,
 * not a reusable catalog or source for future matches. */
import { randomBytes } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { isRecord, type CourseSpecification } from './domain.js';
import type { Player, RoundScore, RoundStatus } from './room-types.js';

const SAMPLE_FIELDS = 5;
const MAX_TIME = 900_000;
const MAX_PLAYER_SAMPLES = 18_010;
const MAX_ROUND_SAMPLES = 300_000;
const MAX_CHUNK_SAMPLES = 128;
const MAX_STATES = 256;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_ROUND_BYTES = 16 * 1024 * 1024;
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

type DeviceState = { at: number; nodes: string[] };
type NativeReplay = {
  path: number[];
  trajectory: number[];
  events: { sample: number; node: string }[];
};
export type ReplayTrack = {
  id: number;
  name: string;
  hue: number;
  color?: string;
  samples: number[];
  states: DeviceState[];
  native?: NativeReplay;
  truncated: boolean;
  strokes: number | null;
  timeMs?: number;
  status: RoundScore['status'] | 'left' | 'unrecorded';
};
export type ReplayRound = {
  index: number;
  title: string;
  status: RoundStatus;
  level: CourseSpecification | null;
  tracks: ReplayTrack[];
  durationMs: number;
  /** Renderer clock when the attempt began; clock-driven devices animate from it. */
  deviceClockMs?: number;
};
export function newReplayId() {
  return randomBytes(24).toString('base64url');
}

function validNative(value: unknown): NativeReplay | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.path) ||
    value.path.length > 1000 ||
    value.path.length % 2 ||
    !value.path.every((entry) => integer(entry, -10_000_000, 10_000_000)) ||
    !Array.isArray(value.trajectory) ||
    value.trajectory.length > 6000 ||
    value.trajectory.length % 3 ||
    !value.trajectory.every((entry) => integer(entry, -10_000_000, 10_000_000)) ||
    !Array.isArray(value.events) ||
    value.events.length > 256
  ) {
    return undefined;
  }
  const events: NativeReplay['events'] = [];
  for (const event of value.events) {
    if (
      !isRecord(event) ||
      !integer(event.sample, 0, Math.max(0, value.trajectory.length / 3 - 1)) ||
      typeof event.node !== 'string' ||
      event.node.length > 80 ||
      !event.node.length
    ) {
      return undefined;
    }
    events.push({ sample: event.sample, node: event.node });
  }
  return { path: value.path, trajectory: value.trajectory, events };
}

export class RoundReplayCapture {
  private readonly tracks = new Map<string, ReplayTrack>();
  private sampleCount = 0;
  /** Earliest device clock reported by any client this round. */
  private deviceClockMs: number | undefined;

  constructor(readonly level: CourseSpecification | null) {}

  private track(player: Player) {
    let track = this.tracks.get(player.uid);
    if (!track) {
      track = {
        id: this.tracks.size,
        name: player.name,
        hue: player.hue,
        color: replayBallColor(player),
        samples: [],
        states: [],
        truncated: false,
        strokes: null,
        status: 'unrecorded',
      };
      this.tracks.set(player.uid, track);
    }
    return track;
  }

  resetPlayer(uid: string) {
    const previous = this.tracks.get(uid);
    if (!previous) {
      return;
    }
    this.sampleCount -= previous.samples.length / SAMPLE_FIELDS;
    previous.samples = [];
    previous.states = [];
    previous.native = undefined;
    previous.truncated = false;
  }

  append(player: Player, payload: unknown, elapsed: number, finished = false) {
    if (
      !isRecord(payload) ||
      !Array.isArray(payload.samples) ||
      payload.samples.length % SAMPLE_FIELDS ||
      payload.samples.length > MAX_CHUNK_SAMPLES * SAMPLE_FIELDS ||
      !Array.isArray(payload.states) ||
      payload.states.length > MAX_STATES
    ) {
      return;
    }
    // Validate the entire batch before writing any samples. Client clocks may
    // differ slightly after transit and clock correction, but cannot run far
    // ahead of the server's authoritative round clock.
    const limit = Math.min(MAX_TIME, elapsed + 2000);
    let previous = -1;
    for (let offset = 0; offset < payload.samples.length; offset += SAMPLE_FIELDS) {
      const [at, coordX, coordY, coordZ, jump] = payload.samples.slice(
        offset,
        offset + SAMPLE_FIELDS,
      );
      if (
        !integer(at, 0, limit) ||
        at <= previous ||
        ![coordX, coordY, coordZ].every((entry) => integer(entry, -10_000_000, 10_000_000)) ||
        !integer(jump, 0, 1)
      ) {
        return;
      }
      previous = at;
    }
    const states: DeviceState[] = [];
    for (const state of payload.states) {
      if (
        !isRecord(state) ||
        !integer(state.at, 0, limit) ||
        !Array.isArray(state.nodes) ||
        state.nodes.length > 128 ||
        !state.nodes.every((id) => typeof id === 'string' && id.length <= 80)
      ) {
        return;
      }
      states.push({ at: state.at, nodes: [...new Set<string>(state.nodes)] });
    }
    const track = this.track(player);
    const reportedClock = payload.deviceClockMs;
    if (
      typeof reportedClock === 'number' &&
      Number.isInteger(reportedClock) &&
      reportedClock >= 0 &&
      reportedClock <= MAX_TIME + 2000
    ) {
      // The earliest clock is nearest the round start; a late joiner must not
      // shift the phase the whole recording replays against.
      this.deviceClockMs =
        this.deviceClockMs === undefined
          ? reportedClock
          : Math.min(this.deviceClockMs, reportedClock);
    }
    for (let offset = 0; offset < payload.samples.length; offset += SAMPLE_FIELDS) {
      const at = payload.samples[offset];
      const last = track.samples.at(-SAMPLE_FIELDS) ?? -1;
      if (at <= last) {
        continue; // Duplicate chunk or reconnect retransmission.
      }
      if (
        track.samples.length >= MAX_PLAYER_SAMPLES * SAMPLE_FIELDS ||
        this.sampleCount >= MAX_ROUND_SAMPLES
      ) {
        track.truncated = true;
        break;
      }
      // Bound the sustained sample rate (20 Hz; tolerate scheduling jitter).
      if (last >= 0 && at - last < 25 && !finished) {
        continue;
      }
      track.samples.push(...payload.samples.slice(offset, offset + SAMPLE_FIELDS));
      this.sampleCount++;
    }
    for (const state of states) {
      if (state.at <= (track.states.at(-1)?.at ?? -1)) {
        continue;
      }
      if (track.states.length >= MAX_STATES) {
        track.truncated = true;
        break;
      }
      track.states.push(state);
    }
    if (finished) {
      track.native = validNative(payload.native);
    }
  }

  finish(
    index: number,
    title: string,
    status: RoundStatus,
    rows: RoundScore[],
    players: Map<string, Player>,
  ): ReplayRound {
    for (const score of rows) {
      const player = players.get(score.uid);
      const track = player ? this.track(player) : this.tracks.get(score.uid);
      if (track) {
        track.strokes = score.strokes;
        track.status = score.status;
        track.timeMs = score.timeMs;
      }
    }
    const tracks = [...this.tracks.values()];
    for (const track of tracks) {
      if (track.status === 'unrecorded' && track.samples.length) {
        track.status = 'left';
      }
    }
    return {
      index,
      title,
      status,
      level: this.level,
      tracks,
      durationMs: Math.max(0, ...tracks.map((track) => track.samples.at(-SAMPLE_FIELDS) ?? 0)),
      ...(this.deviceClockMs === undefined ? {} : { deviceClockMs: this.deviceClockMs }),
    };
  }
}

type RoundSummary = Omit<ReplayRound, 'level' | 'tracks'> & {
  players: Array<
    Pick<
      ReplayTrack,
      'id' | 'name' | 'hue' | 'color' | 'status' | 'strokes' | 'timeMs' | 'truncated'
    > & {
      recorded: boolean;
      native: boolean;
    }
  >;
};
function summarize(round: ReplayRound): RoundSummary {
  return {
    index: round.index,
    title: round.title,
    status: round.status,
    durationMs: round.durationMs,
    players: round.tracks.map(
      ({ id, name, hue, color, status, strokes, timeMs, truncated, samples, native }) => ({
        id,
        name,
        hue,
        color,
        status,
        strokes,
        timeMs,
        truncated,
        recorded: samples.length > 0,
        native: !!native?.trajectory.length,
      }),
    ),
  };
}

export class ReplayArchive {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS replay_matches (id TEXT PRIMARY KEY, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS replay_rounds (
        match_id TEXT NOT NULL, hole INTEGER NOT NULL, summary TEXT NOT NULL, payload BLOB NOT NULL,
        PRIMARY KEY(match_id, hole)
      );`);
    this.prune();
  }

  /**
   * Enforce the archive budget.
   *
   * Recordings are kept indefinitely by age, so the only reason to remove one is
   * that the archive has outgrown its budget: the newest matches are kept and the
   * oldest are dropped until the total fits. A leaderboard row can therefore
   * outlive the replay it points at, which is why a link is only advertised while
   * the archive still holds the match (see `retained`).
   *
   * The budget is a parameter so a test can drive eviction without writing a
   * gigabyte; production always uses the module default.
   */
  prune(budgetBytes = MAX_ARCHIVE_BYTES) {
    const remove = this.db.query('DELETE FROM replay_rounds WHERE match_id = ?');
    const removeMatch = this.db.query('DELETE FROM replay_matches WHERE id = ?');
    const matches = this.db
      .query<{ id: string; size: number }, []>(
        'SELECT m.id, COALESCE(SUM(length(r.payload)+length(r.summary)),0) AS size FROM replay_matches m LEFT JOIN replay_rounds r ON r.match_id=m.id GROUP BY m.id ORDER BY m.created DESC, m.id',
      )
      .all();
    let retained = 0;
    this.db.transaction(() => {
      for (const match of matches) {
        retained += match.size;
        if (retained > budgetBytes) {
          remove.run(match.id);
          removeMatch.run(match.id);
        }
      }
    })();
  }

  record(id: string, round: ReplayRound) {
    const serialized = JSON.stringify(round);
    if (Buffer.byteLength(serialized) > MAX_ROUND_BYTES) {
      return false;
    }
    const payload = Bun.gzipSync(Buffer.from(serialized));
    this.db.transaction(() => {
      this.db.query('INSERT OR IGNORE INTO replay_matches VALUES (?, ?)').run(id, Date.now());
      this.db
        .query('INSERT OR REPLACE INTO replay_rounds VALUES (?, ?, ?, ?)')
        .run(id, round.index, JSON.stringify(summarize(round)), payload);
    })();
    this.prune();
    return !!this.db.query('SELECT 1 FROM replay_matches WHERE id=?').get(id);
  }

  summary(id: string) {
    const match = this.db
      .query<{ created: number }, [string]>('SELECT created FROM replay_matches WHERE id=?')
      .get(id);
    if (!match) {
      return null;
    }
    const rounds = this.db
      .query<{ summary: string }, [string]>(
        'SELECT summary FROM replay_rounds WHERE match_id=? ORDER BY hole',
      )
      .all(id);
    return {
      created: match.created,
      rounds: rounds.map(({ summary }) => JSON.parse(summary)),
    };
  }

  round(id: string, hole: number) {
    const row = this.db
      .query<{ payload: Uint8Array }, [string, number]>(
        'SELECT r.payload FROM replay_rounds r JOIN replay_matches m ON m.id=r.match_id WHERE r.match_id=? AND r.hole=?',
      )
      .get(id, hole);
    return row ? Bun.gunzipSync(new Uint8Array(row.payload)) : null;
  }

  /**
   * Which of the given replay ids the archive still holds.
   *
   * A leaderboard row outlives its replay whenever the archive is pruned under its
   * budget, so a link must be offered only for ids this returns. One query rather
   * than one per row, because a leaderboard page is up to a hundred rows.
   */
  retained(ids: readonly string[]): Set<string> {
    const present = new Set<string>();
    if (!ids.length) {
      return present;
    }
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db
      .query<{ id: string }, string[]>(
        `SELECT id FROM replay_matches WHERE id IN (${placeholders})`,
      )
      .all(...ids);
    for (const row of rows) {
      present.add(row.id);
    }
    return present;
  }
}
