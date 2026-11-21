/**
 * Turn a course specification into the collision geometry the physics engine
 * needs, matching what the pinned client builds.
 *
 * The client does this in one stage (`CourseEventDevices-*.js`, `Ue()`): each
 * placed piece is a GLB model transformed onto the course grid, and its
 * triangles are sorted into "floor" (upward-facing) and "wall" (everything
 * else). A piece whose floor is flat also contributes a skirt: a plate three
 * millimetres below it that closes the hairline gap between neighbouring
 * pieces, so a rolling ball cannot catch the seam.
 *
 * This module reproduces that stage. It is the part of the port that decides
 * whether a replay is faithful, so the rules are taken from the client's own
 * constants rather than chosen:
 *
 *  - a triangle is floor when the y component of its normal exceeds
 *    `FLOOR_NORMAL_Y` (0.6), computed *before* any tilt is applied, exactly
 *    as the client does;
 *  - a wall triangle thinner than `MIN_WALL_HEIGHT` (0.04 m) in y is dropped,
 *    because it is a degenerate sliver rather than a surface;
 *  - a piece is skipped when the registry marks it `noCollide` (a loop or
 *    half-pipe, whose motion comes from an event device);
 *  - a placement may carry `tilt`: a rotation in degrees about the piece's
 *    own origin, applied after the grid transform to the stored vertices but
 *    not to the floor/wall classification;
 *  - when a registry entry names a `floorGlb`, that model's triangles join the
 *    collider alongside the drawn model's — not instead of it;
 *  - the skirt is dropped below the lowest floor vertex by `SKIRT_DROP` (3 mm),
 *    is emitted as a `box` quad or a `deck` plate-per-triangle depending on the
 *    registry's `safetyNet`, and is skipped entirely for `noSkirt` pieces, the
 *    three hole pieces (`NO_SKIRT_PIECES`), tilted placements, and floors that
 *    span more than `MAX_SKIRT_SPAN` (0.3 m) in height;
 *  - vertices are quantised to `QUANTISE` (1e4) so shared corners weld.
 *
 * Everything is expressed in world metres. The course grid is a 2 m cell, and a
 * placement's `x`/`z` are in cells, so they are multiplied by 2; `y` is
 * already in metres. A placement's `rot` is in quarter-turns, negated.
 */
import type { CourseSpecification } from '../domain.js';
import { readGlbPrimitives, type GlbPrimitive } from './glb.js';
import { NO_SKIRT_PIECES, pieceTemplate, type PieceTemplate } from './piece-registry.js';

/** Half-extent multiplier for a placement, in metres per grid cell. */
const CELL_SIZE = 2;
/**
 * Height above a placement's `y` that the *ball and cup* sit at.
 *
 * The client exports this as `B` (`runtime-*.js`, `var B=.063*2`) and adds it to
 * both the ball and the cup, with the ball a further centimetre up so it starts
 * resting on the surface rather than in it. It is not applied to the geometry:
 * the piece meshes are already modelled at their playing height.
 */
export const PIECE_LIFT = 0.063 * 2;

const FLOOR_NORMAL_Y = 0.6;
const MIN_WALL_HEIGHT = 0.04;
/**
 * How far below a piece's lowest floor triangle its skirt sits.
 *
 * The client's `Ae` is 0.003 — three millimetres, not a deep apron. The skirt
 * exists to close the hairline gap between neighbouring pieces so a rolling
 * ball cannot catch an edge, not to catch a ball that leaves the course.
 */
const SKIRT_DROP = 0.003;
/**
 * How close a floor triangle must sit to the lowest floor vertex for a `deck`
 * skirt to plate underneath it.
 *
 * The client's `je` is 0.01: a `deck` skirt flattens only the triangles that
 * already share the floor's lowest level, not every floor triangle.
 */
const DECK_FLOOR_TOLERANCE = 0.01;
/**
 * A skirt is only added to a piece whose floor spans at most this much height.
 *
 * The client's `Le` is 0.3. A piece taller than that is a ramp or a loop, and a
 * flat plate under it would cut through the slope the ball is meant to climb.
 */
const MAX_SKIRT_SPAN = 0.3;
const QUANTISE = 1e4;

/** The cup's capture radius, from the client's physics constants. */
const BALL_CUP_RADIUS = 0.134;

export interface CourseGeometry {
  /** Upward-facing course surface, as a triangle soup in world metres. */
  floor: { positions: Float32Array; indices: Uint32Array };
  /** Side surfaces, walls and skirts. */
  wall: { positions: Float32Array; indices: Uint32Array };
  /** Where the ball starts, in world metres. */
  spawn: [number, number, number];
  /** Cup centre and radius, in world metres. */
  cup: { x: number; y: number; z: number; radius: number };
  /** The highest floor point, used to sanity-check a reported trajectory. */
  extent: { minX: number; maxX: number; minZ: number; maxZ: number; maxY: number };
}

type Triangle = { a: number[]; b: number[]; c: number[]; floor: boolean };

const quantise = (value: number) => Math.round(value * QUANTISE) / QUANTISE;

/**
 * The client's placement transform: rotate about y by `-rot` quarter-turns,
 * scale the model by the cell size, then translate to the cell origin.
 */
function transformPoint(
  point: number[],
  origin: { x: number; y: number; z: number },
  rotation: number,
  scale: number,
): number[] {
  const angle = -rotation * (Math.PI / 2);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const scaledX = point[0] * scale;
  const scaledY = point[1] * scale;
  const scaledZ = point[2] * scale;
  return [
    scaledX * cos + scaledZ * sin + origin.x,
    scaledY + origin.y,
    -scaledX * sin + scaledZ * cos + origin.z,
  ];
}

/**
 * Apply a placement's tilt: `rotationZ(tilt[1]°)` after `rotationX(tilt[0]°)`,
 * about the piece's origin, matching the client's `W` matrix.
 */
function tiltPoint(
  point: number[],
  origin: { x: number; y: number; z: number },
  tilt: number[],
): number[] {
  const alpha = tilt[0] * (Math.PI / 180);
  const beta = tilt[1] * (Math.PI / 180);
  const localX = point[0] - origin.x;
  const localY = point[1] - origin.y;
  const localZ = point[2] - origin.z;
  const cosA = Math.cos(alpha);
  const sinA = Math.sin(alpha);
  const cosB = Math.cos(beta);
  const sinB = Math.sin(beta);
  // rotX(alpha)
  const y1 = localY * cosA - localZ * sinA;
  const z1 = localY * sinA + localZ * cosA;
  // rotZ(beta)
  const x2 = localX * cosB - y1 * sinB;
  const y2 = localX * sinB + y1 * cosB;
  return [x2 + origin.x, y2 + origin.y, z1 + origin.z];
}

function triangleNormal(first: number[], second: number[], third: number[]): number[] {
  const ab = [second[0] - first[0], second[1] - first[1], second[2] - first[2]];
  const ac = [third[0] - first[0], third[1] - first[1], third[2] - first[2]];
  const nx = ab[1] * ac[2] - ab[2] * ac[1];
  const ny = ab[2] * ac[0] - ab[0] * ac[2];
  const nz = ab[0] * ac[1] - ab[1] * ac[0];
  const length = Math.hypot(nx, ny, nz);
  return length < 1e-12 ? [0, 0, 0] : [nx / length, ny / length, nz / length];
}

/**
 * The client's `Me()`: the skirt triangles under a piece's floor.
 *
 * `box` — the default — is one flat quad spanning the floor's bounding box.
 * `deck` is a flattened copy of every floor triangle that already sits within
 * `DECK_FLOOR_TOLERANCE` of the lowest vertex, used by the `-v2` corner
 * variants whose floors are not axis-aligned boxes.
 */
function skirtFor(floorTriangles: number[][], safetyNet: PieceTemplate['safetyNet']): Triangle[] {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minY = Infinity;
  for (const triangle of floorTriangles) {
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const vertexX = triangle[vertex * 3];
      const vertexY = triangle[vertex * 3 + 1];
      const vertexZ = triangle[vertex * 3 + 2];
      if (vertexX < minX) {
        minX = vertexX;
      }
      if (vertexX > maxX) {
        maxX = vertexX;
      }
      if (vertexY < minY) {
        minY = vertexY;
      }
      if (vertexZ < minZ) {
        minZ = vertexZ;
      }
      if (vertexZ > maxZ) {
        maxZ = vertexZ;
      }
    }
  }
  const bottom = minY - SKIRT_DROP;
  if (safetyNet === 'deck') {
    const plates: Triangle[] = [];
    for (const triangle of floorTriangles) {
      const highest = Math.max(triangle[1], triangle[4], triangle[7]);
      if (highest > minY + DECK_FLOOR_TOLERANCE) {
        continue;
      }
      plates.push({
        a: [triangle[0], bottom, triangle[2]],
        b: [triangle[3], bottom, triangle[5]],
        c: [triangle[6], bottom, triangle[8]],
        floor: true,
      });
    }
    return plates;
  }
  return [
    {
      a: [minX, bottom, minZ],
      b: [maxX, bottom, maxZ],
      c: [maxX, bottom, minZ],
      floor: true,
    },
    {
      a: [minX, bottom, minZ],
      b: [minX, bottom, maxZ],
      c: [maxX, bottom, maxZ],
      floor: true,
    },
  ];
}

/** Weld triangles into an indexed mesh, deduplicating by quantised position. */
function weld(triangles: Triangle[]): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = [];
  const indices: number[] = [];
  const seen = new Map<string, number>();
  for (const triangle of triangles) {
    for (const point of [triangle.a, triangle.b, triangle.c]) {
      const pointX = quantise(point[0]);
      const pointY = quantise(point[1]);
      const pointZ = quantise(point[2]);
      const key = `${pointX},${pointY},${pointZ}`;
      let index = seen.get(key);
      if (index === undefined) {
        index = positions.length / 3;
        positions.push(pointX, pointY, pointZ);
        seen.set(key, index);
      }
      indices.push(index);
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

interface Placement {
  piece?: unknown;
  x?: unknown;
  y?: unknown;
  z?: unknown;
  rot?: unknown;
  tilt?: unknown;
}

/** A placement's tilt pair, or `null` when it is absent or flat. */
function placementTilt(placement: Placement): number[] | null {
  const tilt = placement.tilt;
  if (!Array.isArray(tilt) || tilt.length < 2) {
    return null;
  }
  const [rx, rz] = [Number(tilt[0]) || 0, Number(tilt[1]) || 0];
  return rx || rz ? [rx, rz] : null;
}

/**
 * Build the collision geometry for a course.
 *
 * `loadPiece` returns the GLB bytes for a model file name, or `null` when the
 * file is missing. It is a parameter rather than a path because the caller
 * owns where the archived client lives, and because tests supply fixtures.
 */
export function buildCourseGeometry(
  specification: CourseSpecification,
  loadPiece: (name: string) => Uint8Array | null,
): CourseGeometry {
  const pieces = Array.isArray(specification.pieces) ? (specification.pieces as Placement[]) : [];
  const triangles: Triangle[] = [];

  for (const placement of pieces) {
    const name = typeof placement.piece === 'string' ? placement.piece : '';
    if (!name) {
      continue;
    }
    const template = pieceTemplate(name);
    if (!template) {
      throw new Error(`Unknown course piece "${name}"`);
    }
    if (template.noCollide) {
      continue;
    }
    // The client's `Ue()` places a piece at `y + lift * 2`, where `lift` is set
    // only by the pieces that sit above their cell.
    const origin = {
      x: (Number(placement.x) || 0) * CELL_SIZE,
      y: (Number(placement.y) || 0) + (template.lift ?? 0) * CELL_SIZE,
      z: (Number(placement.z) || 0) * CELL_SIZE,
    };
    const rotation = Number(placement.rot) || 0;
    const tilt = placementTilt(placement);

    // When the registry names a `floorGlb`, the client walks BOTH scenes — the
    // drawn model and the floor model contribute triangles to the collider.
    const modelFiles = template.floorGlb ? [template.glb, template.floorGlb] : [template.glb];
    const pieceFloor: number[][] = [];
    for (const file of modelFiles) {
      const bytes = loadPiece(file);
      if (!bytes) {
        throw new Error(`No model for course piece "${name}" (${file})`);
      }
      const primitives: GlbPrimitive[] = readGlbPrimitives(bytes);
      for (const primitive of primitives) {
        for (let at = 0; at + 2 < primitive.indices.length; at += 3) {
          const read = (which: number) => {
            const index = primitive.indices[at + which] * 3;
            return [
              primitive.positions[index],
              primitive.positions[index + 1],
              primitive.positions[index + 2],
            ];
          };
          const first = transformPoint(read(0), origin, rotation, CELL_SIZE);
          const second = transformPoint(read(1), origin, rotation, CELL_SIZE);
          const third = transformPoint(read(2), origin, rotation, CELL_SIZE);
          // The client classifies floor vs wall on the untilted normal, then
          // tilts the stored vertices — a tilted face keeps its untilted role.
          const isFloor = triangleNormal(first, second, third)[1] > FLOOR_NORMAL_Y;
          const vertexA = tilt ? tiltPoint(first, origin, tilt) : first;
          const vertexB = tilt ? tiltPoint(second, origin, tilt) : second;
          const vertexC = tilt ? tiltPoint(third, origin, tilt) : third;
          if (isFloor) {
            pieceFloor.push([...vertexA, ...vertexB, ...vertexC]);
          } else {
            const height =
              Math.max(vertexA[1], vertexB[1], vertexC[1]) -
              Math.min(vertexA[1], vertexB[1], vertexC[1]);
            if (height < MIN_WALL_HEIGHT) {
              continue; // A sliver, not a surface.
            }
          }
          triangles.push({ a: vertexA, b: vertexB, c: vertexC, floor: isFloor });
        }
      }
    }

    // The skirt needs a flat floor, an untilted placement and a piece that is
    // not a hole: the client's condition verbatim.
    if (!tilt && pieceFloor.length && !template.noSkirt && !NO_SKIRT_PIECES.has(name)) {
      let lowest = Infinity;
      let highest = -Infinity;
      for (const triangle of pieceFloor) {
        for (let vertex = 0; vertex < 3; vertex += 1) {
          const vertexY = triangle[vertex * 3 + 1];
          if (vertexY < lowest) {
            lowest = vertexY;
          }
          if (vertexY > highest) {
            highest = vertexY;
          }
        }
      }
      if (highest - lowest <= MAX_SKIRT_SPAN) {
        triangles.push(...skirtFor(pieceFloor, template.safetyNet));
      }
    }
  }

  const floorTriangles = triangles.filter((triangle) => triangle.floor);
  const wallTriangles = triangles.filter((triangle) => !triangle.floor);
  if (!floorTriangles.length) {
    throw new Error('Course has no floor geometry to collide with');
  }

  const ball = (specification.ball ?? {}) as Placement;
  const cup = (specification.cup ?? {}) as Placement;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let maxY = -Infinity;
  for (const triangle of floorTriangles) {
    for (const point of [triangle.a, triangle.b, triangle.c]) {
      if (point[0] < minX) {
        minX = point[0];
      }
      if (point[0] > maxX) {
        maxX = point[0];
      }
      if (point[2] < minZ) {
        minZ = point[2];
      }
      if (point[2] > maxZ) {
        maxZ = point[2];
      }
      if (point[1] > maxY) {
        maxY = point[1];
      }
    }
  }

  return {
    floor: weld(floorTriangles),
    wall: weld(wallTriangles),
    // Matches the client's `Lr()`: the ball is at its own grid position plus the
    // deck lift and a centimetre, and the cup at its position plus the lift.
    spawn: [
      (Number(ball.x) || 0) * CELL_SIZE,
      (Number(ball.y) || 0) + PIECE_LIFT + 0.01,
      (Number(ball.z) || 0) * CELL_SIZE,
    ],
    cup: {
      x: (Number(cup.x) || 0) * CELL_SIZE,
      y: (Number(cup.y) || 0) + PIECE_LIFT,
      z: (Number(cup.z) || 0) * CELL_SIZE,
      radius: BALL_CUP_RADIUS,
    },
    extent: { minX, maxX, minZ, maxZ, maxY },
  };
}
