/**
 * The smallest glTF 2.0 binary (`.glb`) reader the homepage's spinning model
 * needs: the first primitive of the first mesh, as triangles, with float
 * positions and normals, optional float vertex colors, and 16- or 32-bit
 * indices. Anything else (textures, skins, node transforms, sparse or
 * quantized accessors) is refused rather than drawn wrong.
 */

export interface GlbMesh {
  positions: Float32Array;
  normals: Float32Array;
  /** RGB per vertex; absent, the mesh draws in one color. */
  colors: Float32Array | null;
  indices: Uint16Array | Uint32Array;
  min: [number, number, number];
  max: [number, number, number];
}

interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

interface BufferView {
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

interface GltfJson {
  accessors?: Accessor[];
  bufferViews?: BufferView[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; mode?: number }[] }[];
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const TRIANGLES = 4;
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC3: 3, VEC4: 4 };

export function parseGlb(buffer: ArrayBuffer): GlbMesh {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) throw new Error("not a glTF 2.0 binary");
  let json: GltfJson | null = null;
  let bin: DataView | null = null;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, length))) as GltfJson;
    else if (type === CHUNK_BIN) bin = new DataView(buffer, start, length);
    offset = start + length;
  }
  if (!json || !bin) throw new Error("missing JSON or BIN chunk");

  const primitive = json.meshes?.[0]?.primitives[0];
  if (!primitive || (primitive.mode ?? TRIANGLES) !== TRIANGLES || primitive.indices === undefined) {
    throw new Error("expected an indexed triangle mesh");
  }

  const read = (index: number | undefined, kind: "float" | "index", width?: number) => {
    const accessor = index === undefined ? undefined : json.accessors?.[index];
    const bufferView = accessor?.bufferView === undefined ? undefined : json.bufferViews?.[accessor.bufferView];
    if (!accessor || !bufferView) throw new Error("unsupported accessor");
    const components = COMPONENTS[accessor.type];
    if (!components || (width !== undefined && components < width)) throw new Error(`unsupported accessor type ${accessor.type}`);
    const size = kind === "float" ? 4 : accessor.componentType === UNSIGNED_SHORT ? 2 : 4;
    if (kind === "float" ? accessor.componentType !== FLOAT : accessor.componentType !== UNSIGNED_SHORT && accessor.componentType !== UNSIGNED_INT) {
      throw new Error("unsupported component type");
    }
    const stride = bufferView.byteStride ?? components * size;
    const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const out = width ?? components;
    if (kind === "index") {
      const indices = size === 2 ? new Uint16Array(accessor.count) : new Uint32Array(accessor.count);
      for (let i = 0; i < accessor.count; i++) {
        indices[i] = size === 2 ? bin.getUint16(base + i * stride, true) : bin.getUint32(base + i * stride, true);
      }
      return { values: indices, accessor };
    }
    const values = new Float32Array(accessor.count * out);
    for (let i = 0; i < accessor.count; i++) {
      for (let c = 0; c < out; c++) values[i * out + c] = bin.getFloat32(base + i * stride + c * 4, true);
    }
    return { values, accessor };
  };

  const position = read(primitive.attributes.POSITION, "float", 3);
  const normal = read(primitive.attributes.NORMAL, "float", 3);
  const color = primitive.attributes.COLOR_0 === undefined ? null : read(primitive.attributes.COLOR_0, "float", 3);
  const indices = read(primitive.indices, "index");
  const { min, max } = position.accessor;
  if (min?.length !== 3 || max?.length !== 3) throw new Error("POSITION needs its bounds");
  return {
    positions: position.values as Float32Array,
    normals: normal.values as Float32Array,
    colors: color ? color.values as Float32Array : null,
    indices: indices.values as Uint16Array | Uint32Array,
    min: [min[0], min[1], min[2]],
    max: [max[0], max[1], max[2]],
  };
}
