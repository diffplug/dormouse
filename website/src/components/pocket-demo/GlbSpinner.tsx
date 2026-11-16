import { useEffect, useRef, useState } from "react";
import cheeseUrl from "../../assets/cheese-wedge.glb?url";

/**
 * The demo's cheese wedge turning in place, drawn with raw WebGL: one lit,
 * vertex-colored mesh needs a few dozen lines of shader and matrix math, not a
 * 3D library.
 */

interface Mesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  min: number[];
  max: number[];
}

/**
 * Reads `cheese-wedge.glb` as exported, not as any `.glb`: one primitive whose
 * POSITION, NORMAL, and COLOR_0 are tightly packed float VEC3s, and whose
 * indices run 0..n-1, so it draws as plain triangles.
 */
function parseGlb(buffer: ArrayBuffer): Mesh {
  const jsonLength = new DataView(buffer).getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLength)));
  const binStart = 20 + jsonLength + 8;
  const { attributes } = json.meshes[0].primitives[0];
  const vec3 = (index: number) => {
    const accessor = json.accessors[index];
    const offset = binStart + (json.bufferViews[accessor.bufferView].byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    return { values: new Float32Array(buffer, offset, accessor.count * 3), min: accessor.min, max: accessor.max };
  };
  const position = vec3(attributes.POSITION);
  return {
    positions: position.values,
    normals: vec3(attributes.NORMAL).values,
    colors: vec3(attributes.COLOR_0).values,
    min: position.min,
    max: position.max,
  };
}

/** Fetched as the demo's chunk loads, so the README step draws at once. */
const MODEL = fetch(cheeseUrl).then((response) => {
  if (!response.ok) throw new Error(`GET ${cheeseUrl}: ${response.status}`);
  return response.arrayBuffer();
}).then(parseGlb);
MODEL.catch(() => {});

const VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec3 aColor;
uniform mat4 uModel;
uniform mat4 uViewProjection;
varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vWorld;
void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorld = world.xyz;
  vNormal = mat3(uModel) * aNormal;
  vColor = aColor;
  gl_Position = uViewProjection * world;
}`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec3 vNormal;
varying vec3 vColor;
varying vec3 vWorld;
uniform vec3 uEye;
void main() {
  vec3 n = normalize(vNormal);
  vec3 light = normalize(vec3(-0.4, 0.8, 0.6));
  vec3 view = normalize(uEye - vWorld);
  float diffuse = max(dot(n, light), 0.0);
  float fill = max(dot(n, normalize(vec3(0.6, -0.2, 0.4))), 0.0) * 0.25;
  float specular = pow(max(dot(n, normalize(light + view)), 0.0), 24.0) * 0.18;
  float rim = pow(1.0 - max(dot(n, view), 0.0), 3.0) * 0.2;
  gl_FragColor = vec4(vColor * (0.32 + 0.68 * diffuse + fill) + specular + rim, 1.0);
}`;

/** Column-major 4×4 matrices, as WebGL reads them. */
type Mat4 = Float32Array;

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2);
  const range = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * range, -1, 0, 0, 2 * far * near * range, 0]);
}

function translation(x: number, y: number, z: number): Mat4 {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
}

function rotationX(angle: number): Mat4 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
}

function rotationY(angle: number): Mat4 {
  const c = Math.cos(angle), s = Math.sin(angle);
  return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("createShader failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader failed");
  return shader;
}

function attribute(gl: WebGLRenderingContext, program: WebGLProgram, name: string, data: Float32Array): void {
  const location = gl.getAttribLocation(program, name);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(location);
  gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 0, 0);
}

/** Uploads the mesh once; `draw` renders any turn angle, `dispose` frees the
 *  context at once rather than leaving one per mount for the GC to find. */
function createRenderer(canvas: HTMLCanvasElement, mesh: Mesh): { draw: (yaw: number) => void; dispose: () => void } | null {
  const gl = canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: true });
  if (!gl) return null;
  const dispose = () => gl.getExtension("WEBGL_lose_context")?.loseContext();

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    dispose();
    return null;
  }
  gl.useProgram(program);

  attribute(gl, program, "aPosition", mesh.positions);
  attribute(gl, program, "aNormal", mesh.normals);
  attribute(gl, program, "aColor", mesh.colors);
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);

  const center = mesh.min.map((low, axis) => (low + mesh.max[axis]) / 2);
  const radius = Math.hypot(...mesh.min.map((low, axis) => mesh.max[axis] - low)) / 2;
  const distance = radius * 3.1;
  const recenter = translation(-center[0], -center[1], -center[2]);
  const tilt = rotationX(0.42);
  const view = translation(0, 0, -distance);
  const uModel = gl.getUniformLocation(program, "uModel");
  const uViewProjection = gl.getUniformLocation(program, "uViewProjection");
  gl.uniform3f(gl.getUniformLocation(program, "uEye"), 0, 0, distance);
  const vertexCount = mesh.positions.length / 3;
  let sized = "";

  const draw = (yaw: number) => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (sized !== `${width}x${height}`) {
      sized = `${width}x${height}`;
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
      gl.uniformMatrix4fv(uViewProjection, false, multiply(perspective(0.7, width / height, radius * 0.1, radius * 10), view));
    }
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.uniformMatrix4fv(uModel, false, multiply(tilt, multiply(rotationY(yaw), recenter)));
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
  };
  return { draw, dispose };
}

export function GlbSpinner({ spinning, label, className }: {
  /** Still, it rests at a three-quarter view. */
  spinning: boolean;
  label: string;
  className?: string;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    // A canvas per run: once `dispose` loses its context, that canvas only
    // ever returns the lost one.
    const canvas = document.createElement("canvas");
    canvas.className = "block h-full w-full";
    holder.append(canvas);
    let frame = 0;
    let cancelled = false;
    let renderer: ReturnType<typeof createRenderer> = null;
    MODEL.then((mesh) => {
      if (cancelled) return;
      renderer = createRenderer(canvas, mesh);
      if (!renderer) {
        setFailed(true);
        return;
      }
      const { draw } = renderer;
      const restingYaw = -0.6;
      if (!spinning) {
        draw(restingYaw);
        return;
      }
      const start = performance.now();
      const tick = (now: number) => {
        draw(restingYaw + ((now - start) / 1000) * 0.9);
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }).catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      renderer?.dispose();
      canvas.remove();
    };
  }, [spinning]);

  return failed ? (
    <div className={`grid place-items-center text-xs opacity-60 ${className ?? ""}`}>{label}</div>
  ) : (
    <div ref={holderRef} role="img" aria-label={label} className={className} />
  );
}
