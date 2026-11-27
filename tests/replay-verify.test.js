/**
 * End-to-end coverage for the replay verifier: the geometry builder, the
 * headless physics replay and the report comparison, all exercised against
 * the archived GLB models rather than fixtures.
 *
 * The physics assertions are deliberately about self-consistency and about the
 * comparison machinery, not about a fixed absolute answer — the Rapier build is
 * pinned but a solver's exact floats are an implementation detail. The one
 * contract that must hold is the same one the feature relies on: the same
 * input on the same course produces the same trajectory.
 */
import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCourseGeometry } from '../src/replay/course-geometry.ts';
import { preparedModelLoader } from '../src/replay/models.ts';
import { normaliseShot } from '../src/replay/constants.ts';
import { loadPhysics, replayShot } from '../src/replay/simulate.ts';
import { unverifiableReason, verifyReplayedRound } from '../src/replay/verify.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loadPiece = preparedModelLoader(path.join(root, 'private-client'));

/**
 * A flat corridor of `open` pieces with a cup at the far end.
 *
 * `open` is chosen deliberately: it is a plain flat floor, so the fixture tests
 * the physics and the comparison rather than the shape of a particular tee or
 * ramp. The `start` piece is a sloped box, and using it here made every shot
 * stall on its lip — a property of that model, not of the verifier.
 */
const SPEC = {
  id: 'verify-fixture',
  name: 'Verification Lane',
  par: 3,
  runtimeVersion: 2,
  ball: { x: 0, y: 0, z: 0 },
  cup: { x: 0, y: 0, z: 5 },
  pieces: [
    { piece: 'open', x: 0, y: 0, z: 0 },
    { piece: 'open', x: 0, y: 0, z: 1 },
    { piece: 'open', x: 0, y: 0, z: 2 },
    { piece: 'open', x: 0, y: 0, z: 3 },
    { piece: 'open', x: 0, y: 0, z: 4 },
    { piece: 'hole-open', x: 0, y: 0, z: 5 },
  ],
};

const engine = await loadPhysics();
const geometry = buildCourseGeometry(SPEC, loadPiece);

describe('course geometry', () => {
  test('builds floor and wall meshes in world metres', () => {
    expect(geometry.floor.indices.length % 3).toBe(0);
    expect(geometry.floor.indices.length).toBeGreaterThan(0);
    expect(geometry.wall.indices.length % 3).toBe(0);
    // The spawn sits a ball-lift plus a centimetre above the tee's `y`.
    expect(geometry.spawn[0]).toBeCloseTo(0, 5);
    expect(geometry.spawn[2]).toBeCloseTo(0, 5);
    expect(geometry.cup.radius).toBeCloseTo(0.134, 5);
  });

  test('rejects an unknown piece instead of guessing its shape', () => {
    const bad = { ...SPEC, pieces: [{ piece: 'not-a-piece', x: 0, y: 0, z: 0 }] };
    expect(() => buildCourseGeometry(bad, loadPiece)).toThrow(/Unknown course piece/);
  });

  test('combines a drawn mesh with its floor model when a piece has both', () => {
    // `round-cap` collides as `hole-round.glb` plus the `open.glb` floor
    // beneath it; the two must both appear, not one replacing the other.
    const capped = {
      ...SPEC,
      pieces: [
        { piece: 'start', x: 0, y: 0, z: 0 },
        { piece: 'round-cap', x: 0, y: 0, z: 1 },
      ],
    };
    const built = buildCourseGeometry(capped, loadPiece);
    const capOnly = {
      ...SPEC,
      pieces: [
        { piece: 'start', x: 0, y: 0, z: 0 },
        { piece: 'open', x: 0, y: 0, z: 1 },
      ],
    };
    const openOnly = buildCourseGeometry(capOnly, loadPiece);
    expect(built.floor.indices.length).toBeGreaterThan(openOnly.floor.indices.length);
  });
});

describe('shot normalisation', () => {
  test('accepts a unit direction with in-range power', () => {
    expect(normaliseShot({ dir: [0, -1], power: 0.5 })).toEqual({ dir: [0, -1], power: 0.5 });
  });
  test('rejects non-unit directions and out-of-range power', () => {
    expect(normaliseShot({ dir: [0, -2], power: 0.5 })).toBeNull();
    expect(normaliseShot({ dir: [0, -1], power: 0 })).toBeNull();
    expect(normaliseShot({ dir: [0, -1], power: 1.5 })).toBeNull();
    expect(normaliseShot({ dir: [0], power: 0.5 })).toBeNull();
    expect(normaliseShot({ dir: 'x', power: 0.5 })).toBeNull();
  });
});

describe('physics replay', () => {
  const shot = { dir: [0, 1], power: 0.4 };

  test('is deterministic for the same input', () => {
    const first = replayShot(engine, { geometry, shot });
    const second = replayShot(engine, { geometry, shot });
    expect(second.trajectory).toEqual(first.trajectory);
    expect(second.rest).toEqual(first.rest);
    expect(second.holed).toBe(first.holed);
  });

  test('moves the ball down the corridor and records the tee first', () => {
    const outcome = replayShot(engine, { geometry, shot });
    expect(outcome.trajectory.length % 3).toBe(0);
    expect(outcome.trajectory.length).toBeGreaterThanOrEqual(6);
    // First sample is the tee, in integer centimetres.
    expect(outcome.trajectory[0]).toBe(Math.round(geometry.spawn[0] * 100));
    expect(outcome.trajectory[2]).toBe(Math.round(geometry.spawn[2] * 100));
    // The ball travelled toward +z and stayed on the course line.
    expect(outcome.rest.z).toBeGreaterThan(geometry.spawn[2] + 0.5);
    expect(Math.abs(outcome.rest.x)).toBeLessThan(0.5);
    // Every sample is an integer centimetre.
    expect(outcome.trajectory.every((value) => Number.isInteger(value))).toBe(true);
  });

  test('a stronger shot travels farther', () => {
    const soft = replayShot(engine, { geometry, shot: { dir: [0, 1], power: 0.2 } });
    const firm = replayShot(engine, { geometry, shot: { dir: [0, 1], power: 0.4 } });
    expect(firm.rest.z).toBeGreaterThan(soft.rest.z);
  });

  test('a hard enough putt is holed', () => {
    const outcome = replayShot(engine, { geometry, shot: { dir: [0, 1], power: 0.6 } });
    expect(outcome.holed).toBe(true);
  });
});

describe('unverifiable courses', () => {
  test('accepts the plain fixture', () => {
    expect(unverifiableReason(SPEC)).toBeNull();
  });
  test('refuses event graphs, spline decks, zones and unknown pieces', () => {
    expect(unverifiableReason({ ...SPEC, events: { nodes: { a: { kind: 'fan' } } } })).toMatch(
      /event devices/,
    );
    expect(unverifiableReason({ ...SPEC, splines: [{ points: [0, 0, 0] }] })).toMatch(/spline/);
    expect(
      unverifiableReason({
        ...SPEC,
        pieces: [...SPEC.pieces, { piece: 'sand', x: 0, y: 0, z: 4 }],
      }),
    ).toMatch(/sand zone/);
    expect(
      unverifiableReason({
        ...SPEC,
        pieces: [...SPEC.pieces, { piece: 'loop', x: 0, y: 0, z: 4 }],
      }),
    ).toMatch(/loop zone/);
    expect(
      unverifiableReason({
        ...SPEC,
        pieces: [...SPEC.pieces, { piece: 'not-a-piece', x: 0, y: 0, z: 4 }],
      }),
    ).toMatch(/unknown piece/);
  });
  test('a spinner without an event graph stays verifiable', () => {
    // A spinner piece is drawn as straight floor and only moves under the
    // course's `events`; without one it is ordinary collision.
    expect(
      unverifiableReason({
        ...SPEC,
        pieces: [...SPEC.pieces, { piece: 'spinner', x: 0, y: 0, z: 4 }],
      }),
    ).toBeNull();
  });
});

describe('round verification', () => {
  test('a replayed report verifies', async () => {
    const shot = { dir: [0, 1], power: 0.4 };
    const outcome = replayShot(engine, { geometry, shot });
    const result = await verifyReplayedRound({
      specification: SPEC,
      shots: [shot],
      reported: { trajectory: outcome.trajectory },
      reportedRest: outcome.rest,
      reportedHoled: outcome.holed,
      loadPiece,
    });
    expect(result.ok).toBe(true);
    expect(result.maxPathDeviationCm).toBeLessThanOrEqual(10);
  });

  test('a fabricated trajectory is rejected', async () => {
    const shot = { dir: [0, 1], power: 0.4 };
    const outcome = replayShot(engine, { geometry, shot });
    // A doctored report: every z pushed 40 cm farther than the ball went.
    const doctored = outcome.trajectory.map((value, index) =>
      index % 3 === 2 ? value + 40 : value,
    );
    const result = await verifyReplayedRound({
      specification: SPEC,
      shots: [shot],
      reported: { trajectory: doctored },
      loadPiece,
    });
    expect(result.ok).toBe(false);
    expect(['path-mismatch', 'rest-mismatch']).toContain(result.failure);
  });

  test('a shot input that does not match the report is rejected', async () => {
    // Report what a 0.7 shot does, then claim the input was 0.3 — the two
    // cannot both be true, so verification must fail.
    const reportedOutcome = replayShot(engine, {
      geometry,
      shot: { dir: [0, 1], power: 0.7 },
    });
    const result = await verifyReplayedRound({
      specification: SPEC,
      shots: [{ dir: [0, 1], power: 0.3 }],
      reported: { trajectory: reportedOutcome.trajectory },
      reportedRest: reportedOutcome.rest,
      loadPiece,
    });
    expect(result.ok).toBe(false);
  });

  test('an event course is refused rather than approximated', async () => {
    const withFan = { ...SPEC, events: { nodes: { n1: { kind: 'fan' } } } };
    const result = await verifyReplayedRound({
      specification: withFan,
      shots: [{ dir: [0, 1], power: 0.4 }],
      reported: { trajectory: [0, 0, 0] },
      loadPiece,
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('event-course');
  });

  test('a hole with no report cannot be checked', async () => {
    const result = await verifyReplayedRound({
      specification: SPEC,
      shots: [{ dir: [0, 1], power: 0.4 }],
      reported: null,
      loadPiece,
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('no-report');
  });
});
