import {
  BufferAttribute,
  CanvasTexture,
  DataTexture,
  GLSL3,
  Group,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  LinearFilter,
  Mesh,
  RawShaderMaterial,
  type Texture,
} from 'three';

/**
 * One frame the fork's renderer drew, as `onSceneFrame` hands it over (diffplug/xterm.js
 * `in-scene-sdf` branch, `IWebglSceneFrame` in the addon's typings). Restated here because the
 * released addon canopy pins predates it; until a fork release carries it, `sceneFrames` finds no
 * such event and panes keep the canvas texture.
 */
export interface SceneFrame {
  readonly resolution: { readonly width: number; readonly height: number };
  readonly glyphs: Float32Array;
  readonly glyphStride: number;
  readonly glyphLayout: {
    readonly offset: number;
    readonly size: number;
    readonly texpage: number;
    readonly texcoord: number;
    readonly texsize: number;
    readonly tint: number;
    readonly sdf: number;
    readonly cellpos: number;
  };
  readonly backgrounds: Float32Array;
  readonly cursor: Float32Array;
  readonly rectStride: number;
  readonly pages: ReadonlyArray<{ readonly canvas: HTMLCanvasElement; readonly version: number }>;
  readonly sdfEdge: number;
}

type SceneFrameSource = {
  readonly sceneFrame: SceneFrame | undefined;
  onSceneFrame(listener: (frame: SceneFrame) => void): { dispose(): void };
};

/** The addon's scene frames, or null when the installed addon has no scene-frame API. */
export function sceneFrames(addon: object): SceneFrameSource | null {
  return 'onSceneFrame' in addon ? (addon as SceneFrameSource) : null;
}

/** Where terminal space lands: a centered flat rect, or a band of a cylinder seen from inside. */
export type Surface =
  | { kind: 'flat'; width: number; height: number }
  | { kind: 'arc'; radius: number; angle0: number; angle1: number; height: number };

/** Atlas pages one draw can sample; the fork's own shader takes up to 16, but a terminal rarely needs 2. */
const MAX_PAGES = 8;
/**
 * How far in front of the surface each layer is drawn, in meters. No layer writes depth: the
 * backgrounds overlap their own full-pane clear rect coplanar, and would z-fight, so each layer
 * paints in instance order and the layers stack by render order and lift.
 */
const BACKGROUND_LIFT_M = 0.0002;
const GLYPH_LIFT_M = 0.0006;
const CURSOR_LIFT_M = 0.0009;

const PLACE = /* glsl */ `
uniform vec4 u_surface;
uniform float u_arc;
uniform float u_lift;
// Terminal space (0,0 top-left .. 1,1 bottom-right) to the surface's local frame.
vec3 place(vec2 t) {
  if (u_arc < 0.5) return vec3((t.x - 0.5) * u_surface.x, (0.5 - t.y) * u_surface.y, u_lift);
  float a = mix(u_surface.y, u_surface.z, t.x);
  float r = u_surface.x - u_lift;
  return vec3(r * sin(a), (0.5 - t.y) * u_surface.w, -r * cos(a));
}`;

const RECT_VERTEX = /* glsl */ `
in vec2 a_unitquad;
in vec2 a_position;
in vec2 a_size;
in vec4 a_color;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
${PLACE}
out vec4 v_color;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(place(a_position + a_unitquad * a_size), 1.0);
  v_color = a_color;
}`;

const RECT_FRAGMENT = /* glsl */ `
precision highp float;
in vec4 v_color;
out vec4 outColor;
void main() { outColor = v_color; }`;

const GLYPH_VERTEX = /* glsl */ `
in vec2 a_unitquad;
in vec2 a_offset;
in vec2 a_size;
in float a_texpage;
in vec2 a_texcoord;
in vec2 a_texsize;
in vec4 a_tint;
in float a_sdf;
in vec2 a_cellpos;
uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform vec2 u_resolution;
${PLACE}
out vec2 v_texcoord;
flat out int v_texpage;
flat out vec4 v_tint;
flat out float v_sdf;
void main() {
  vec2 t = a_offset / u_resolution + a_cellpos + a_unitquad * a_size;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(place(t), 1.0);
  v_texcoord = a_texcoord + a_unitquad * a_texsize;
  v_texpage = int(a_texpage);
  v_tint = a_tint;
  v_sdf = a_sdf;
}`;

const pageLookups = Array.from({ length: MAX_PAGES - 1 }, (_, i) => ` else if (v_texpage == ${i + 1}) { texel = texture(u_pages[${i + 1}], v_texcoord); }`).join('');
const GLYPH_FRAGMENT = /* glsl */ `
precision highp float;
in vec2 v_texcoord;
flat in int v_texpage;
flat in vec4 v_tint;
flat in float v_sdf;
uniform sampler2D u_pages[${MAX_PAGES}];
uniform float u_sdfEdge;
out vec4 outColor;
void main() {
  vec4 texel;
  if (v_texpage == 0) { texel = texture(u_pages[0], v_texcoord); }${pageLookups}
  if (v_sdf > 0.5) {
    // The fork's SDF edge, now under the scene's projection: fwidth keeps the edge about one
    // output pixel wide however far the pane is tilted or zoomed.
    float d = texel.a;
    float w = max(fwidth(d), 0.0001);
    outColor = vec4(v_tint.rgb, smoothstep(u_sdfEdge - w, u_sdfEdge + w, d) * v_tint.a);
  } else {
    outColor = texel;
  }
  if (outColor.a < 0.004) discard;
}`;

/** A unit quad, instanced: `a_unitquad` runs (0,0)..(1,1). */
function unitQuadGeometry(): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('a_unitquad', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
  // Unused by the shaders, but iWSDK builds a BVH for everything under a ray target and needs it.
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
  geometry.setIndex([0, 2, 1, 1, 2, 3]);
  geometry.instanceCount = 0;
  return geometry;
}

/** An instanced layer whose per-instance floats are copied in each frame, growing as needed. */
class InstanceLayer {
  readonly geometry = unitQuadGeometry();
  readonly mesh: Mesh;
  private buffer: InstancedInterleavedBuffer | null = null;

  constructor(
    material: RawShaderMaterial,
    renderOrder: number,
    private readonly fields: (stride: number) => Record<string, [offset: number, size: number]>,
  ) {
    this.mesh = new Mesh(this.geometry, material);
    this.mesh.renderOrder = renderOrder;
    // Culling reads the unit quad, not where instances land.
    this.mesh.frustumCulled = false;
    this.mesh.raycast = () => {};
  }

  set(data: Float32Array, stride: number) {
    const count = data.length / stride;
    if (!this.buffer || this.buffer.stride !== stride || this.buffer.array.length < data.length) {
      this.buffer = new InstancedInterleavedBuffer(new Float32Array(Math.max(data.length, stride * 64) * 2), stride);
      for (const [name, [offset, size]] of Object.entries(this.fields(stride))) {
        this.geometry.setAttribute(name, new InterleavedBufferAttribute(this.buffer, size, offset));
      }
    }
    (this.buffer.array as Float32Array).set(data);
    this.buffer.needsUpdate = true;
    this.geometry.instanceCount = count;
  }

  dispose() {
    this.geometry.dispose();
  }
}

/**
 * Draws a terminal's scene frames into the Three.js scene — backgrounds (selection included),
 * glyph quads, cursor — on a `Surface`, with the fork's SDF coverage in the scene's own shader, so
 * text stays crisp where a texture of the canvas would be resampled. Never a ray target.
 */
export class InSceneText {
  readonly object = new Group();
  private readonly surface = { u_surface: { value: [1, 1, 0, 0] as number[] }, u_arc: { value: 0 } };
  private readonly backgrounds: InstanceLayer;
  private readonly glyphs: InstanceLayer;
  private readonly cursor: InstanceLayer;
  private readonly glyphMaterial: RawShaderMaterial;
  private readonly pages: { canvas: HTMLCanvasElement; version: number; width: number; height: number; texture: CanvasTexture }[] = [];
  private readonly blank = new DataTexture(new Uint8Array(4), 1, 1);
  private readonly unsubscribe: () => void;

  constructor(source: SceneFrameSource) {
    this.blank.needsUpdate = true;
    const rectMaterial = (lift: number) =>
      new RawShaderMaterial({
        glslVersion: GLSL3,
        vertexShader: RECT_VERTEX,
        fragmentShader: RECT_FRAGMENT,
        uniforms: { ...this.surface, u_lift: { value: lift } },
        transparent: true,
        depthWrite: false,
      });
    const rectFields = (): Record<string, [number, number]> => ({ a_position: [0, 2], a_size: [2, 2], a_color: [4, 4] });
    this.backgrounds = new InstanceLayer(rectMaterial(BACKGROUND_LIFT_M), 1, rectFields);
    this.cursor = new InstanceLayer(rectMaterial(CURSOR_LIFT_M), 3, rectFields);
    this.glyphMaterial = new RawShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: GLYPH_VERTEX,
      fragmentShader: GLYPH_FRAGMENT,
      uniforms: {
        ...this.surface,
        u_lift: { value: GLYPH_LIFT_M },
        u_resolution: { value: [1, 1] },
        u_sdfEdge: { value: 0.75 },
        u_pages: { value: Array.from({ length: MAX_PAGES }, () => this.blank as Texture) },
      },
      transparent: true,
      depthWrite: false,
    });
    let layout: SceneFrame['glyphLayout'] | null = null;
    this.glyphs = new InstanceLayer(this.glyphMaterial, 2, () => {
      const l = layout!;
      return {
        a_offset: [l.offset, 2],
        a_size: [l.size, 2],
        a_texpage: [l.texpage, 1],
        a_texcoord: [l.texcoord, 2],
        a_texsize: [l.texsize, 2],
        a_tint: [l.tint, 4],
        a_sdf: [l.sdf, 1],
        a_cellpos: [l.cellpos, 2],
      };
    });
    this.object.add(this.backgrounds.mesh, this.glyphs.mesh, this.cursor.mesh);

    const apply = (frame: SceneFrame) => {
      layout = frame.glyphLayout;
      this.glyphMaterial.uniforms.u_resolution.value = [frame.resolution.width, frame.resolution.height];
      this.glyphMaterial.uniforms.u_sdfEdge.value = frame.sdfEdge;
      this.syncPages(frame.pages);
      this.backgrounds.set(frame.backgrounds, frame.rectStride);
      this.glyphs.set(frame.glyphs, frame.glyphStride);
      this.cursor.set(frame.cursor, frame.rectStride);
    };
    if (source.sceneFrame) apply(source.sceneFrame);
    const sub = source.onSceneFrame(apply);
    this.unsubscribe = () => sub.dispose();
  }

  setSurface(surface: Surface) {
    this.surface.u_arc.value = surface.kind === 'arc' ? 1 : 0;
    this.surface.u_surface.value =
      surface.kind === 'arc' ? [surface.radius, surface.angle0, surface.angle1, surface.height] : [surface.width, surface.height, 0, 0];
  }

  private syncPages(pages: SceneFrame['pages']) {
    const textures = this.glyphMaterial.uniforms.u_pages.value as Texture[];
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = pages[i];
      const held = this.pages[i];
      if (!page) {
        textures[i] = this.blank;
        continue;
      }
      if (!held || held.canvas !== page.canvas) {
        held?.texture.dispose();
        const texture = new CanvasTexture(page.canvas);
        // The fork samples its atlas top-down, unpremultiplied, without mipmaps.
        texture.flipY = false;
        texture.generateMipmaps = false;
        texture.minFilter = LinearFilter;
        texture.magFilter = LinearFilter;
        this.pages[i] = { canvas: page.canvas, version: page.version, width: page.canvas.width, height: page.canvas.height, texture };
      } else if (held.version !== page.version) {
        // A page that grew keeps its canvas object; three's texture storage is immutable.
        if (held.width !== page.canvas.width || held.height !== page.canvas.height) {
          held.texture.dispose();
          held.width = page.canvas.width;
          held.height = page.canvas.height;
        }
        held.texture.needsUpdate = true;
        held.version = page.version;
      }
      textures[i] = this.pages[i].texture;
    }
  }

  dispose() {
    this.unsubscribe();
    this.backgrounds.dispose();
    this.glyphs.dispose();
    this.cursor.dispose();
    for (const page of this.pages) page.texture.dispose();
    this.blank.dispose();
  }
}
