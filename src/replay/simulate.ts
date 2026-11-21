/**
 * Replay a recorded shot through the same physics the client plays.
 *
 * This is the verification half of the feature: given a course, a starting
 * position and the exact shot input, it produces the trajectory the ball takes
 * and the position it comes to rest at. The client records its own trajectory,
 * so the two can be compared — and a report that does not reproduce is a report
 * that was not produced by this engine on this course.
 *
 * What is deliberately reproduced from the client, and where each rule comes
 * from:
 *
 *  - **the world**: gravity `(0, -9.81, 0)`, a fixed `1/120 s` step, a dynamic
 *    ball with the client's damping, friction, restitution and contact skin, and
 *    a fixed trimesh course split into floor and wall surfaces;
 *  - **the shot**: `applyImpulse(dir * power * maxShotSpeed * mass)` plus a
 *    torque impulse, so the resulting speed is `power * maxShotSpeed` regardless
 *    of mass — the mass factor is present in the client only to make the impulse
 *    mass-independent, and it cancels;
 *  - **the roll**: the same linear damping, and the sampler records a sample
 *    every `0.04 s` of simulated time as integer centimetres;
 *  - **the cup**: the client's own capture test, including the assist force that
 *    pulls a slow ball within `cupAssistRadius` toward the hole.
 *
 * What is *not* reproduced: course event devices (fans, magnets, geysers, ramps
 * that move), which the client drives from its scene graph. A course using them
 * is refused rather than replayed approximately, because an approximation would
 * report an honest player as a cheat.
 */
import type RAPIER from '@dimforge/rapier3d-compat';
import { BALL, MAX_SAMPLES, SAMPLE_INTERVAL, TIME_STEP } from './constants.js';
import type { CourseGeometry } from './course-geometry.js';

/** A shot as the client computed it, before it becomes an impulse. */
export interface ShotInput {
  dir: [number, number];
  power: number;
}

/** What a replay produced. */
export interface ReplayOutcome {
  /** Integer centimetres, `x, y, z` per sample, in the client's own encoding. */
  trajectory: number[];
  /** Where the ball stopped, in world metres. */
  rest: { x: number; y: number; z: number };
  /** Whether the ball went in the cup. */
  holed: boolean;
  /** Simulated seconds the ball was in motion. */
  durationMs: number;
  /** True when the ball left the course and the replay gave up. */
  outOfBounds: boolean;
}

let rapier: typeof RAPIER | null = null;

/**
 * Load the physics engine once per process.
 *
 * The version is pinned in `package.json` to the build the archived client
 * ships (Rapier 0.19.2), because a different solver version produces different
 * floats and the whole comparison depends on the two agreeing.
 */
export async function loadPhysics(): Promise<typeof RAPIER> {
  if (rapier) {
    return rapier;
  }
  const module = await import('@dimforge/rapier3d-compat');
  const loaded = module.default ?? module;
  await loaded.init();
  rapier = loaded;
  return loaded;
}

interface ReplayOptions {
  geometry: CourseGeometry;
  shot: ShotInput;
  /** Start position; defaults to the course's tee. */
  spawn?: [number, number, number];
  /** Give up after this much simulated time. */
  maxSeconds?: number;
}

/**
 * Run one shot and return the trajectory it produces.
 *
 * The ball is placed at the tee with the client's own offset (the spawn point is
 * the ground, and the ball's centre sits one radius above it), given the shot
 * impulse, and stepped until it stops, is holed or leaves the course.
 */
export function replayShot(engine: typeof RAPIER, options: ReplayOptions): ReplayOutcome {
  const { geometry, shot } = options;
  const spawn = options.spawn ?? geometry.spawn;
  const maxSeconds = options.maxSeconds ?? 60;

  const world = new engine.World({ x: 0, y: -9.81, z: 0 });
  try {
    world.integrationParameters.dt = TIME_STEP;

    // `FIX_INTERNAL_EDGES` is not optional for fidelity: the client passes it on
    // both course colliders (`CourseEventDevices-*.js`, `args:[vertices,
    // indices,FIX_INTERNAL_EDGES]`). Without it a sphere catches on the internal
    // edges between two triangles of the same flat floor and hops, which is
    // exactly the artefact seen when this flag was omitted.
    const trimeshFlags = engine.TriMeshFlags.FIX_INTERNAL_EDGES;
    const courseBody = world.createRigidBody(engine.RigidBodyDesc.fixed());
    if (geometry.floor.indices.length) {
      world.createCollider(
        engine.ColliderDesc.trimesh(geometry.floor.positions, geometry.floor.indices, trimeshFlags)
          .setFriction(BALL.floorFriction)
          .setRestitution(BALL.floorRestitution),
        courseBody,
      );
    }
    if (geometry.wall.indices.length) {
      world.createCollider(
        engine.ColliderDesc.trimesh(geometry.wall.positions, geometry.wall.indices, trimeshFlags)
          .setFriction(BALL.wallFriction)
          .setRestitution(BALL.wallRestitution),
        courseBody,
      );
    }

    const ballBody = world.createRigidBody(
      engine.RigidBodyDesc.dynamic()
        .setCcdEnabled(true)
        .setLinearDamping(BALL.linearDamping)
        .setAngularDamping(BALL.angularDamping)
        .setTranslation(spawn[0], spawn[1] + BALL.radius, spawn[2]),
    );
    world.createCollider(
      engine.ColliderDesc.ball(BALL.radius)
        .setFriction(BALL.ballFriction)
        .setRestitution(BALL.ballRestitution)
        .setContactSkin(BALL.contactSkin),
      ballBody,
    );

    // The client's impulse: speed is `power * maxShotSpeed` after dividing by
    // mass, and the torque gives the ball its roll.
    const speed = shot.power * BALL.maxShotSpeed;
    const mass = ballBody.mass();
    ballBody.wakeUp();
    ballBody.applyImpulse(
      { x: shot.dir[0] * speed * mass, y: 0, z: shot.dir[1] * speed * mass },
      true,
    );
    const torque = 0.4 * mass * BALL.radius * speed;
    ballBody.applyTorqueImpulse({ x: torque * shot.dir[1], y: 0, z: -torque * shot.dir[0] }, true);

    // The client interleaves physics and post-step logic once per render frame,
    // not once per simulation step: its `advance()` runs the world for as many
    // whole `1/120 s` steps as fit in the frame's delta, then the frame callback
    // reads the body, applies rolling resistance and spin decay scaled by the
    // frame's delta `p`, and pushes a sample. Replaying with a fixed step and no
    // render frames is still equivalent, because the per-frame forces are scaled
    // by `p`, so applying them once per fixed step at `p = TIME_STEP` produces
    // the same integrated effect a frame's `N` substeps followed by one `N *
    // TIME_STEP` impulse does.
    //
    // The recorded samples land at `p`-accumulated `0.04 s` intervals, but `p`
    // is quantized to whole steps on the client, so a sample's index is not a
    // reliable timestamp — the same shot can record one sample more or fewer
    // depending on where frame boundaries fell. The verifier therefore compares
    // the reported trajectory to the replayed path, not sample-by-sample.
    const trajectory: number[] = [];
    // The client arms its sampler with `P.current = xn` on the firing frame, so
    // the tee is recorded immediately; starting at zero would silently drop that
    // first point and shift every later sample by one interval.
    let accumulator = SAMPLE_INTERVAL;
    let elapsed = 0;
    let holed = false;
    let outOfBounds = false;
    let stillFor = 0;

    // `surface` is the client's `k` zone factor: 1 on plain ground, and only
    // different inside an event zone (sand, ice, a magnet), which the verifier
    // refuses rather than approximates. A plain course leaves it at 1.
    const surface = 1;

    const steps = Math.ceil(maxSeconds / TIME_STEP);
    for (let step = 0; step < steps; step += 1) {
      const position = ballBody.translation();
      const velocity = ballBody.linvel();
      const planarSpeed = Math.hypot(velocity.x, velocity.z);

      if (position.y < BALL.oobY) {
        outOfBounds = true;
        break;
      }

      // The client's capture test, verbatim: above the cup and either inside the
      // wide radius, or inside the cup radius while slow enough to drop.
      const dx = geometry.cup.x - position.x;
      const dz = geometry.cup.z - position.z;
      const distance = Math.hypot(dx, dz);
      const above = position.y > geometry.cup.y - BALL.sinkDepth;
      const withinReach = position.y < geometry.cup.y && distance < BALL.cupRadius * 1.5;
      const speedNow = Math.hypot(velocity.x, velocity.y, velocity.z);
      const slowEnough = distance < BALL.cupRadius && speedNow < BALL.captureSpeed;
      if (above && (withinReach || slowEnough)) {
        holed = true;
        break;
      }

      // The cup assist: a slow ball near the hole is drawn toward it.
      if (
        distance < BALL.cupAssistRadius &&
        planarSpeed < BALL.cupAssistMaxSpeed &&
        planarSpeed > 1e-4
      ) {
        const pull = (BALL.cupAssistAccel * TIME_STEP * mass) / planarSpeed;
        ballBody.applyImpulse({ x: dx * pull, y: 0, z: dz * pull }, true);
      }

      // Rolling resistance, applied exactly as the client does: reduce the
      // planar velocity by `rollDecel * surface * step` metres per second,
      // never below zero, and keep the vertical component untouched. `surface`
      // is the client's `k` zone factor (1 on plain ground, higher on sand).
      if (planarSpeed > 0.02) {
        const scale = Math.max(planarSpeed - BALL.rollDecel * surface * TIME_STEP, 0) / planarSpeed;
        ballBody.setLinvel({ x: velocity.x * scale, y: velocity.y, z: velocity.z * scale }, true);
      }

      // Spin bleeds off exponentially once the ball is moving slowly, matching
      // the client's `exp(-6 * p)`. For the replay `p` is the fixed step.
      const spinVector = ballBody.angvel();
      const spinSpeed = Math.hypot(spinVector.x, spinVector.y, spinVector.z);
      if (planarSpeed < 0.3) {
        const decay = Math.exp(-6 * TIME_STEP);
        ballBody.setAngvel(
          {
            x: spinVector.x * decay,
            y: spinVector.y * decay,
            z: spinVector.z * decay,
          },
          true,
        );
      }

      // The sampler advances by the step, matching the client's accumulator —
      // a full client step is always `1/120 s`, so a fixed-step replay lands a
      // sample at the same accumulated `p` as the client's per-frame version.
      accumulator += TIME_STEP;
      if (accumulator >= SAMPLE_INTERVAL && trajectory.length / 3 < MAX_SAMPLES) {
        accumulator %= SAMPLE_INTERVAL;
        trajectory.push(
          Math.round(position.x * 100),
          Math.round(position.y * 100),
          Math.round(position.z * 100),
        );
      }

      // The client's rest test: total speed below `stopSpeed` and total spin
      // below `stopSpin`, held for `stillSeconds`, or the body falls asleep.
      const totalSpeed = Math.hypot(velocity.x, velocity.y, velocity.z);
      if (totalSpeed < BALL.stopSpeed && spinSpeed < BALL.stopSpin) {
        stillFor += TIME_STEP;
      } else {
        stillFor = 0;
      }
      if (stillFor >= BALL.stillSeconds || ballBody.isSleeping()) {
        ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
        ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
        break;
      }

      world.step();
      elapsed += TIME_STEP;
    }

    const rest = ballBody.translation();
    return {
      trajectory,
      rest: { x: rest.x, y: rest.y, z: rest.z },
      holed,
      durationMs: Math.round(elapsed * 1000),
      outOfBounds,
    };
  } finally {
    world.free();
  }
}
