import { useEffect, useRef, useState } from "react";
import { parseGlb, type GlbMesh } from "./glb";

/**
 * A `.glb` model turning in place, drawn with raw WebGL: one lit, vertex-colored
 * mesh needs a few dozen lines of shader and matrix math, not a 3D library.
 */

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

/** Uploads the mesh once and returns a draw for any turn angle. */
function createRenderer(canvas: HTMLCanvasElement, mesh: GlbMesh): ((yaw: number) => void) | null {
  const gl = canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: true });
  if (!gl) return null;
  const wideIndices = mesh.indices instanceof Uint32Array;
  if (wideIndices && !gl.getExtension("OES_element_index_uint")) return null;

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);

  attribute(gl, program, "aPosition", mesh.positions);
  attribute(gl, program, "aNormal", mesh.normals);
  attribute(gl, program, "aColor", mesh.colors ?? new Float32Array(mesh.positions.length).fill(0.8));
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  gl.enable(gl.DEPTH_TEST);

  const center = mesh.min.map((low, axis) => (low + mesh.max[axis]) / 2);
  const radius = Math.hypot(...mesh.min.map((low, axis) => mesh.max[axis] - low)) / 2;
  const distance = radius * 3.1;
  const eye = new Float32Array([0, 0, distance]);
  const recenter = translation(-center[0], -center[1], -center[2]);
  const uModel = gl.getUniformLocation(program, "uModel");
  const uViewProjection = gl.getUniformLocation(program, "uViewProjection");
  gl.uniform3fv(gl.getUniformLocation(program, "uEye"), eye);
  const indexType = wideIndices ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;

  return (yaw: number) => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const model = multiply(rotationX(0.42), multiply(rotationY(yaw), recenter));
    const viewProjection = multiply(perspective(0.7, width / height, radius * 0.1, radius * 10), translation(0, 0, -distance));
    gl.uniformMatrix4fv(uModel, false, model);
    gl.uniformMatrix4fv(uViewProjection, false, viewProjection);
    gl.drawElements(gl.TRIANGLES, mesh.indices.length, indexType, 0);
  };
}

const meshes = new Map<string, Promise<GlbMesh>>();

/** Fetched and parsed once per page, so the demo's next loop draws at once. */
export function loadGlb(src: string): Promise<GlbMesh> {
  let mesh = meshes.get(src);
  if (!mesh) {
    mesh = fetch(src).then((response) => {
      if (!response.ok) throw new Error(`GET ${src}: ${response.status}`);
      return response.arrayBuffer();
    }).then(parseGlb);
    meshes.set(src, mesh);
    mesh.catch(() => meshes.delete(src));
  }
  return mesh;
}

export function GlbSpinner({ src, spinning, label, className }: {
  src: string;
  /** Still, it rests at a three-quarter view. */
  spinning: boolean;
  label: string;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let frame = 0;
    let cancelled = false;
    loadGlb(src).then((mesh) => {
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const draw = createRenderer(canvas, mesh);
      if (!draw) {
        setFailed(true);
        return;
      }
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
    };
  }, [spinning, src]);

  return failed ? (
    <div className={`grid place-items-center text-xs opacity-60 ${className ?? ""}`}>{label}</div>
  ) : (
    <canvas ref={canvasRef} role="img" aria-label={label} className={className} />
  );
}
