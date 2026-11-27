/**
 * A minimal GLB reader, for the replay verifier only.
 *
 * The verifier has to rebuild a course's collision geometry, and the collision
 * geometry is the triangle meshes of the piece models. Those models are GLB
 * files pinned in the client snapshot, so this reads the bytes directly instead
 * of going through a glTF library: the server needs positions and indices, not
 * materials, textures or animations, and a full loader would add a dependency
 * whose parsing differences could silently change the mesh a shot collides with.
 *
 * Only the parts needed for that are implemented, and anything unexpected
 * throws rather than guessing. A verifier that quietly substitutes an empty mesh
 * for a piece would accept every shot against a flat plane, which is worse than
 * refusing to verify at all.
 */

/** One mesh primitive: a triangle soup in the file's own coordinate space. */
export interface GlbPrimitive {
  positions: Float32Array;
  indices: Uint32Array;
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const COMPONENT_TYPES: Record<
  number,
  { size: number; read: (view: DataView, at: number) => number }
> = {
  5120: { size: 1, read: (view, at) => view.getInt8(at) },
  5121: { size: 1, read: (view, at) => view.getUint8(at) },
  5122: { size: 2, read: (view, at) => view.getInt16(at, true) },
  5123: { size: 2, read: (view, at) => view.getUint16(at, true) },
  5125: { size: 4, read: (view, at) => view.getUint32(at, true) },
  5126: { size: 4, read: (view, at) => view.getFloat32(at, true) },
};

const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
}
interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}
interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  mode?: number;
}
interface GltfMesh {
  primitives: GltfPrimitive[];
  name?: string;
}
interface GltfNode {
  mesh?: number;
  name?: string;
  children?: number[];
  /** A 4x4 column-major transform, used instead of the TRS fields below. */
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface GltfDocument {
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  meshes?: GltfMesh[];
  nodes?: GltfNode[];
  scenes?: { nodes?: number[] }[];
}

/** The node name whose subtree the client leaves out of the collision mesh. */
const BLADES_NODE = 'blades';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major 4x4 multiply, matching glTF's own layout. */
function multiplyMatrix(left: number[], right: number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let inner = 0; inner < 4; inner += 1) {
        sum += left[inner * 4 + row] * right[column * 4 + inner];
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/** Compose a node's transform: an explicit matrix, or its translation/rotation/scale. */
function nodeTransform(node: GltfNode): number[] {
  if (node.matrix) {
    return node.matrix;
  }
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

/** Apply a column-major 4x4 to a point. */
function applyMatrix(
  matrix: number[],
  pointX: number,
  pointY: number,
  pointZ: number,
): [number, number, number] {
  return [
    matrix[0] * pointX + matrix[4] * pointY + matrix[8] * pointZ + matrix[12],
    matrix[1] * pointX + matrix[5] * pointY + matrix[9] * pointZ + matrix[13],
    matrix[2] * pointX + matrix[6] * pointY + matrix[10] * pointZ + matrix[14],
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read every triangle primitive in a GLB.
 *
 * Node transforms are deliberately not applied: the caller places the whole
 * piece with its own rotation and scale, which is how the client's own level
 * builder works. Applying them here as well would double the transform.
 */
export function readGlbPrimitives(bytes: Uint8Array): GlbPrimitive[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error('Not a GLB file');
  }
  if (view.getUint32(4, true) !== 2) {
    throw new Error('Unsupported GLB version');
  }

  let document: GltfDocument | null = null;
  let binary: Uint8Array | null = null;
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const length = view.getUint32(at, true);
    const kind = view.getUint32(at + 4, true);
    const start = at + 8;
    if (start + length > bytes.byteLength) {
      throw new Error('GLB chunk runs past the end of the file');
    }
    if (kind === CHUNK_JSON) {
      const parsed: unknown = JSON.parse(
        new TextDecoder().decode(bytes.subarray(start, start + length)),
      );
      if (!isRecord(parsed)) {
        throw new Error('GLB JSON chunk is not an object');
      }
      document = parsed;
    } else if (kind === CHUNK_BIN) {
      binary = bytes.subarray(start, start + length);
    }
    at = start + length;
  }
  if (!document) {
    throw new Error('GLB has no JSON chunk');
  }
  if (!binary) {
    throw new Error('GLB has no binary chunk');
  }

  const accessors = document.accessors ?? [];
  const bufferViews = document.bufferViews ?? [];
  const binaryView = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);

  const readAccessor = (index: number): number[] => {
    const accessor = accessors[index];
    if (!accessor) {
      throw new Error(`GLB accessor ${index} is missing`);
    }
    const components = TYPE_COMPONENTS[accessor.type];
    const component = COMPONENT_TYPES[accessor.componentType];
    if (!components || !component) {
      throw new Error(`GLB accessor ${index} has an unsupported type`);
    }
    if (accessor.bufferView === undefined) {
      throw new Error(`GLB accessor ${index} has no buffer view`);
    }
    const bufferView = bufferViews[accessor.bufferView];
    if (!bufferView) {
      throw new Error(`GLB buffer view ${accessor.bufferView} is missing`);
    }
    const elementSize = component.size * components;
    const stride = bufferView.byteStride ?? elementSize;
    const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const values: number[] = [];
    for (let element = 0; element < accessor.count; element += 1) {
      const offset = base + element * stride;
      for (let componentIndex = 0; componentIndex < components; componentIndex += 1) {
        const byteOffset = offset + componentIndex * component.size;
        if (byteOffset + component.size > binary.byteLength) {
          throw new Error(`GLB accessor ${index} reads past the binary chunk`);
        }
        values.push(component.read(binaryView, byteOffset));
      }
    }
    return values;
  };

  const primitives: GlbPrimitive[] = [];

  const collectMesh = (meshIndex: number, transform: number[]) => {
    const mesh = (document.meshes ?? [])[meshIndex];
    if (!mesh) {
      throw new Error(`GLB node refers to missing mesh ${meshIndex}`);
    }
    for (const primitive of mesh.primitives) {
      // Mode 4 is TRIANGLES, which is all the pinned piece models use. Anything
      // else would need triangulation, and silently dropping it would leave a
      // hole in the course that the ball would fall through.
      const mode = primitive.mode ?? 4;
      if (mode !== 4) {
        throw new Error(`GLB primitive mode ${mode} is not supported`);
      }
      const positionIndex = primitive.attributes.POSITION;
      if (positionIndex === undefined) {
        continue;
      }
      const raw = readAccessor(positionIndex);
      const positions = new Float32Array(raw.length);
      for (let offset = 0; offset < raw.length; offset += 3) {
        const [worldX, worldY, worldZ] = applyMatrix(
          transform,
          raw[offset],
          raw[offset + 1],
          raw[offset + 2],
        );
        positions[offset] = worldX;
        positions[offset + 1] = worldY;
        positions[offset + 2] = worldZ;
      }
      const indices =
        primitive.indices === undefined
          ? Array.from({ length: positions.length / 3 }, (ignored, vertexIndex) => vertexIndex)
          : readAccessor(primitive.indices);
      primitives.push({ positions, indices: Uint32Array.from(indices) });
    }
  };

  // Walk from the scene roots so a node's own transform is applied to the mesh
  // it carries. The client does the same (`updateMatrixWorld`, then each mesh's
  // `matrixWorld`), and two kinds of model depend on it: the spline pieces sit a
  // unit below their origin, and a windmill's blades are a second mesh offset up
  // and back. Applying no transform at all would place both in the wrong spot.
  const nodes = document.nodes ?? [];
  const roots = document.scenes?.flatMap((scene) => scene.nodes ?? []) ?? [];
  const visit = (nodeIndex: number, parent: number[]) => {
    const node = nodes[nodeIndex];
    if (!node) {
      return;
    }
    const local = nodeTransform(node);
    const world = multiplyMatrix(parent, local);
    // The client skips anything under a node named `blades`: a windmill's blades
    // turn as an event device, and their resting pose is not part of the course
    // the ball rolls on. Including them would put a moving obstacle in the mesh.
    if (node.name === BLADES_NODE) {
      return;
    }
    if (node.mesh !== undefined) {
      collectMesh(node.mesh, world);
    }
    for (const child of node.children ?? []) {
      visit(child, world);
    }
  };

  if (roots.length) {
    for (const root of roots) {
      visit(root, IDENTITY);
    }
  } else {
    // A model with meshes but no scene still has geometry worth reading.
    for (let index = 0; index < (document.meshes ?? []).length; index += 1) {
      collectMesh(index, IDENTITY);
    }
  }

  if (!primitives.length) {
    throw new Error('GLB contains no drawable triangles');
  }
  return primitives;
}
