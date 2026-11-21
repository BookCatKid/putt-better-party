/**
 * Check a reported round against the physics that produced it.
 *
 * A client reports two things the server can check: the shot inputs it fired
 * (`shot` frames, stored on the replay track) and the trajectory its own
 * physics produced (`replay-samples` and the native `trajectory` on the finish
 * frame). Because the server runs the same engine — the pinned Rapier build is
 * byte-identical to the client's inlined WASM — an honest report is a
 * deterministic function of the course and the inputs, and a report that does
 * not reproduce was not produced by this game on this course.
 *
 * The comparison is deliberately not sample-by-sample. The client samples its
 * trajectory once per render frame at `0.04 s` of accumulated frame time, so
 * the same physical shot records a slightly different sample count and phase
 * depending on where frame boundaries fell — measured at up to ~6 cm of index
 * misalignment on an honest run. What is stable is the path itself: every
 * reported point must lie close to the replayed path, the run must end where
 * the replay ends, and a holed report must reproduce as holed.
 *
 * Courses the client drives with event devices (zones, portals, loops,
 * animated nodes) or spline decks are refused rather than replayed
 * approximately, because an approximation would report an honest player as a
 * cheat.
 */
import type { CourseSpecification } from '../domain.js';
import { buildCourseGeometry, type CourseGeometry } from './course-geometry.js';
import { loadPhysics, replayShot, type ShotInput } from './simulate.js';
import { ACTIVE_SPECIALS, pieceTemplate } from './piece-registry.js';

/**
 * How far a reported point may sit from the replayed path before the report is
 * counted as not reproducing, in centimetres.
 *
 * Measured against a recorded real run: every point of an honest trajectory
 * lies within ~6 cm of the replayed path, the divergence coming from the
 * client's per-frame sampling phase rather than from the physics. The bound is
 * set well above that measurement so honest runs pass with margin, while a
 * fabricated trajectory — which cannot reproduce the path without running the
 * same physics — cannot come near it.
 */
export const PATH_TOLERANCE_CM = 10;

/** Why a report could not be, or was not, verified. */
export type VerificationFailure =
  | 'no-report'
  | 'event-course'
  | 'unknown-piece'
  | 'no-geometry'
  | 'path-mismatch'
  | 'rest-mismatch'
  | 'holed-mismatch'
  | 'engine-error';

export interface ShotVerification {
  /** Whether every recorded shot reproduced inside the tolerances. */
  ok: boolean;
  /** When `ok` is false, why. */
  failure?: VerificationFailure;
  /** Detail for operators: which shot and what distance failed. */
  detail?: string;
  /** Shots that were replayed and compared. */
  shots: number;
  /** Worst point-to-path distance seen, in centimetres. */
  maxPathDeviationCm: number;
}

interface ReportedReplay {
  trajectory?: unknown;
  path?: unknown;
}

interface VerifyRoundOptions {
  specification: CourseSpecification;
  /** The recorded shot inputs, in the order the strokes were taken. */
  shots: ShotInput[];
  /** The client-reported native replay, when one was sent. */
  reported: ReportedReplay | null;
  /** The reported final rest position, when known (world metres). */
  reportedRest?: { x: number; y: number; z: number } | null;
  /** Whether the report claims the ball was holed. */
  reportedHoled?: boolean;
  /** Resolve a model file name to its bytes. */
  loadPiece: (name: string) => Uint8Array | null;
}

/**
 * Whether a specification uses something the replay does not model.
 *
 * Checked before any physics runs: an event graph, spline deck surfaces, or a
 * piece carrying an active zone (`special`) means the client's own engine had
 * inputs the verifier does not have.
 */
export function unverifiableReason(specification: CourseSpecification): string | null {
  const events = specification.events;
  if (events && typeof events === 'object') {
    const nodes = (events as { nodes?: unknown }).nodes;
    if (nodes && typeof nodes === 'object' && Object.keys(nodes).length) {
      return 'the course uses event devices';
    }
  }
  if (Array.isArray(specification.splines) && specification.splines.length) {
    return 'the course uses spline deck surfaces';
  }
  const pieces = Array.isArray(specification.pieces) ? specification.pieces : [];
  for (const placement of pieces) {
    if (!placement || typeof placement !== 'object') {
      continue;
    }
    const name = (placement as { piece?: unknown }).piece;
    if (typeof name !== 'string') {
      continue;
    }
    const template = pieceTemplate(name);
    if (!template) {
      return `unknown piece "${name}"`;
    }
    if (template.special && ACTIVE_SPECIALS.has(template.special)) {
      return `piece "${name}" carries a ${template.special} zone`;
    }
    if (name === 'loop') {
      return 'the course contains a loop zone';
    }
  }
  return null;
}

/** Distance from a point to the nearest point on a path, in centimetres. */
function pointToPathCm(
  pointX: number,
  pointY: number,
  pointZ: number,
  path: ArrayLike<number>,
): number {
  let best = Infinity;
  for (let at = 0; at + 2 < path.length; at += 3) {
    const distance = Math.hypot(path[at] - pointX, path[at + 1] - pointY, path[at + 2] - pointZ);
    if (distance < best) {
      best = distance;
    }
  }
  return best;
}

/**
 * Replay every recorded shot and compare the result against the report.
 *
 * Shots chain from rest to rest: shot *i* starts where shot *i* − 1 stopped
 * (or at the tee for the first), which is how the client itself plays — a ball
 * must come to rest before the next putt is allowed.
 */
export async function verifyReplayedRound(options: VerifyRoundOptions): Promise<ShotVerification> {
  const { specification, shots, reported, loadPiece } = options;
  const empty = { shots: shots.length, maxPathDeviationCm: 0 };

  const reason = unverifiableReason(specification);
  if (reason) {
    return { ok: false, failure: 'event-course', detail: reason, ...empty };
  }
  if (!reported || !Array.isArray(reported.trajectory) || reported.trajectory.length % 3) {
    return { ok: false, failure: 'no-report', ...empty };
  }
  const reportedPath = reported.trajectory as number[];

  let geometry: CourseGeometry;
  try {
    geometry = buildCourseGeometry(specification, loadPiece);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = message.startsWith('Unknown course piece') ? 'unknown-piece' : 'no-geometry';
    return { ok: false, failure, detail: message, ...empty };
  }

  let engine;
  try {
    engine = await loadPhysics();
  } catch (error) {
    return {
      ok: false,
      failure: 'engine-error',
      detail: error instanceof Error ? error.message : String(error),
      ...empty,
    };
  }

  // Chain the recorded shots: each starts where the last came to rest.
  const replayed: number[] = [];
  let spawn: [number, number, number] | undefined;
  let rest = { x: geometry.spawn[0], y: geometry.spawn[1], z: geometry.spawn[2] };
  let holed = false;
  for (const shot of shots) {
    const outcome = replayShot(engine, { geometry, shot, spawn });
    replayed.push(...outcome.trajectory);
    rest = outcome.rest;
    spawn = [outcome.rest.x, outcome.rest.y, outcome.rest.z];
    if (outcome.holed) {
      holed = true;
      break; // A holed ball takes no further shots.
    }
  }

  // Every reported point must sit on the replayed path. Deviation is the
  // point's distance to the nearest replayed sample — a path check rather than
  // an index check, so the client's frame-phase jitter cannot fail it.
  let worst = 0;
  let worstIndex = -1;
  for (let at = 0; at + 2 < reportedPath.length; at += 3) {
    const deviation = pointToPathCm(
      reportedPath[at],
      reportedPath[at + 1],
      reportedPath[at + 2],
      replayed,
    );
    if (deviation > worst) {
      worst = deviation;
      worstIndex = at / 3;
    }
  }
  if (worst > PATH_TOLERANCE_CM) {
    return {
      ok: false,
      failure: 'path-mismatch',
      detail: `sample ${worstIndex} sits ${worst.toFixed(1)} cm off the replayed path`,
      shots: shots.length,
      maxPathDeviationCm: worst,
    };
  }

  // The reported rest is the last point of the reported trajectory when the
  // client ended still; the replay's rest must land beside it.
  const reportedEnd = options.reportedRest ?? {
    x: reportedPath[reportedPath.length - 3] / 100,
    y: reportedPath[reportedPath.length - 2] / 100,
    z: reportedPath[reportedPath.length - 1] / 100,
  };
  const restError = Math.hypot(rest.x - reportedEnd.x, rest.z - reportedEnd.z) * 100;
  if (restError > PATH_TOLERANCE_CM) {
    return {
      ok: false,
      failure: 'rest-mismatch',
      detail: `replayed rest is ${restError.toFixed(1)} cm from the reported end`,
      shots: shots.length,
      maxPathDeviationCm: worst,
    };
  }

  if (options.reportedHoled !== undefined && options.reportedHoled !== holed) {
    return {
      ok: false,
      failure: 'holed-mismatch',
      detail: `report ${options.reportedHoled ? 'claims' : 'denies'} holed, replay found ${holed}`,
      shots: shots.length,
      maxPathDeviationCm: worst,
    };
  }

  return { ok: true, shots: shots.length, maxPathDeviationCm: worst };
}
