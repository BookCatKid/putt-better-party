/**
 * The physics constants the pinned client plays with.
 *
 * Taken from `RenderDriver-*.js` (exported as `K`) and read directly rather than
 * tuned: a verifier only agrees with the client if it uses the same numbers, and
 * an approximation would show up as a stroke that differs on a long putt.
 *
 * `timeStep` is the fixed simulation step. The client's `advance()` accumulates
 * frame time and emits whole steps of exactly this length, clamping one frame to
 * `timeStep * 24`; the replay runs the same step length with no accumulation,
 * because it has no frames to accumulate.
 *
 * `sampleInterval` is the trajectory sampling period: the client pushes a sample
 * every 0.04 s of simulated time, which is 4.8 steps. Positions are stored as
 * integer centimetres, so a comparison against a recorded trajectory is exact
 * when the two agree to the centimetre.
 */
export const BALL = {
  radius: 0.06,
  contactSkin: 0.006,
  linearDamping: 0.25,
  angularDamping: 0.4,
  rollDecel: 0.8,
  ballFriction: 0.4,
  ballRestitution: 0.35,
  floorFriction: 0.8,
  floorRestitution: 0.05,
  wallFriction: 0.1,
  wallRestitution: 0.7,
  maxShotSpeed: 10,
  minPull: 0.12,
  maxPull: 1.8,
  captureSpeed: 2.6,
  cupRadius: 0.134,
  cupAssistRadius: 0.42,
  cupAssistAccel: 5.5,
  cupAssistMaxSpeed: 3.4,
  sinkDepth: 0.3,
  stopSpeed: 0.12,
  stopSpin: 0.5,
  stillSeconds: 0.17,
  watchdogSeconds: 10,
  oobY: -2,
} as const;

/** The fixed simulation step, in seconds. */
export const TIME_STEP = 1 / 120;

/** How much simulated time passes between recorded samples, in seconds. */
export const SAMPLE_INTERVAL = 0.04;

/** A frame may carry at most this many steps before the excess is discarded. */
export const MAX_STEPS_PER_FRAME = 24;

/** The longest a single hole's trajectory may be, in samples. */
export const MAX_SAMPLES = 6000;

/**
 * How the client turns a pointer pull into a shot.
 *
 * Recovered from the client's pointer handler: the pull vector is normalised and
 * negated (`dir`), and the stored power is the pull length over `maxPull`,
 * raised to 1.6 and clamped to 1. Because the two are computed in that order, a
 * submitted `power` must be consistent with a pull no longer than `maxPull`, and
 * `dir` must be a unit vector in the xz plane.
 */
export function normaliseShot(input: { dir: unknown; power: unknown }): {
  dir: [number, number];
  power: number;
} | null {
  const { dir, power } = input;
  if (typeof power !== 'number' || !Number.isFinite(power) || power <= 0 || power > 1) {
    return null;
  }
  if (!Array.isArray(dir) || dir.length !== 2) {
    return null;
  }
  const [dirX, dirZ] = dir;
  if (
    typeof dirX !== 'number' ||
    typeof dirZ !== 'number' ||
    !Number.isFinite(dirX) ||
    !Number.isFinite(dirZ)
  ) {
    return null;
  }
  const length = Math.hypot(dirX, dirZ);
  // The client normalises before sending, so a vector that is not already unit
  // length means the frame did not come from the client's own shot path.
  if (Math.abs(length - 1) > 1e-3) {
    return null;
  }
  return { dir: [dirX, dirZ], power };
}
