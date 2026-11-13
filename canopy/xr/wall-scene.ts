import { RayInteractable, XRCylinderLayer, type Entity, type World } from '@iwsdk/core';
import {
  BackSide,
  CanvasTexture,
  CylinderGeometry,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Object3D,
} from 'three';
import { hitTest, type DropCandidate } from 'lath/hit-test';
import { layout, sashes, type LayoutOpts } from 'lath/layout';
import { leafTree, leaves, type LathTree, type LeafId, type Rect } from 'lath/model';
import { move, resize, split } from 'lath/ops';
import { demoContent } from '../src/demo-content';
import { attachEchoShell } from './echo-shell';
import { attachPaneInput, onPointer, type Fraction, type PointerHit } from './input';
import { InSceneText, sceneFrames } from './in-scene-text';
import { cannedSource, type PaneSource } from './pane-source';
import { createSceneTerminal, type SceneTerminal } from './terminal';

/** Lath lays the wall out in terminal CSS px; this is how big one is in the scene. */
const M_PER_PX = 1 / 900;
/** The cylinder the wall is wrapped on, centered on the viewer's starting position. */
const RADIUS_M = 1.6;
const WALL: Rect = { x: 0, y: 0, width: 2700, height: 1000 };
const WALL_TOP_M = 2.15;
const OPTS: LayoutOpts = { gap: 10, minLeaf: { width: 260, height: 140 } };
const HEADER_PX = 26;
/** A sash's ray target, wider than its visible gap so a controller can find it. */
const SASH_HIT_PX = 26;
/**
 * Quest composites at most 16 layers, one of them the projection layer the rest of the scene draws
 * into; panes past this many are curved meshes instead. `?layers=N` lowers it to show the fallback.
 */
const MAX_COMPOSITION_LAYERS = 15;

type Point = { x: number; y: number };

/** Angle around the cylinder of wall x (0 straight ahead, positive to the viewer's right). */
const angleOf = (x: number) => ((x - WALL.width / 2) * M_PER_PX) / RADIUS_M;
const heightOf = (y: number) => WALL_TOP_M - y * M_PER_PX;

/** Where a world point (a ray hit) falls on the wall, in wall px. */
export function wallPoint(p: Vector3): Point {
  return { x: WALL.width / 2 + (Math.atan2(p.x, -p.z) * RADIUS_M) / M_PER_PX, y: (WALL_TOP_M - p.y) / M_PER_PX };
}

const rayDir = new Vector3();
/** Where an event's ray meets the wall's cylinder, in wall px (see `PointerHit`). */
function rayWallPoint(e: PointerHit): Point {
  const o = e.pointerPosition;
  rayDir.set(0, 0, -1).applyQuaternion(e.pointerQuaternion);
  // |o.xz + t·d.xz| = R, taking the exit (far) root since the ray starts inside the cylinder.
  const a = rayDir.x ** 2 + rayDir.z ** 2;
  const b = 2 * (o.x * rayDir.x + o.z * rayDir.z);
  const c = o.x ** 2 + o.z ** 2 - RADIUS_M ** 2;
  const disc = b * b - 4 * a * c;
  if (a < 1e-9 || disc < 0) return wallPoint(e.point);
  const t = (-b + Math.sqrt(disc)) / (2 * a);
  return wallPoint(new Vector3().copy(o).addScaledVector(rayDir, t));
}

/** The world point at wall px `(x, y)`, `inset` meters in front of the wall. */
export function worldPoint(x: number, y: number, inset = 0): Vector3 {
  const a = angleOf(x);
  const r = RADIUS_M - inset;
  return new Vector3(r * Math.sin(a), heightOf(y), -r * Math.cos(a));
}

/**
 * A wall rect as a curved strip seen from inside the cylinder, `inset` meters in front of the wall,
 * centered on its own height so `mesh.position.y` places it. Three's cylinder runs theta the other
 * way round from the wall's x, so u is mirrored back.
 */
function arcGeometry(rect: Rect, inset = 0): BufferGeometry {
  const a0 = angleOf(rect.x);
  const a1 = angleOf(rect.x + rect.width);
  const r = RADIUS_M - inset;
  const geometry = new CylinderGeometry(r, r, rect.height * M_PER_PX, Math.max(2, Math.ceil((a1 - a0) * 48)), 1, true, Math.PI - a1, a1 - a0);
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
  return geometry;
}

function placeArc(mesh: Mesh, rect: Rect, inset = 0) {
  mesh.geometry.dispose();
  mesh.geometry = arcGeometry(rect, inset);
  mesh.position.y = heightOf(rect.y + rect.height / 2);
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** A 2D canvas texture sized to a wall rect in px, so text on it is drawn at the wall's resolution. */
function labelTexture() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return {
    texture,
    draw(width: number, height: number, paint: (ctx: CanvasRenderingContext2D) => void) {
      const w = Math.max(1, Math.round(width));
      const h = Math.max(1, Math.round(height));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        texture.dispose();
      }
      paint(ctx);
      texture.needsUpdate = true;
    },
  };
}

interface WallPane {
  id: LeafId;
  redrawHeader(): void;
  terminal: SceneTerminal;
  kind: 'layer' | 'mesh';
  /** The terminal area, below the header, from the last layout. */
  termRect: Rect;
  header: Mesh;
  /** What the ray hits over the terminal: the curved mesh, or the layer's entity. */
  body: Object3D;
  place(rect: Rect): void;
}

/**
 * The default scene: terminals tiled by Lath's pure core on a cylinder around the viewer. Controller
 * rays drag a pane by its header (Lath's `hitTest` previews the drop, `move` commits it), drag the
 * sashes between panes (`resize` against the drag-start tree), and act as the mouse inside each
 * terminal.
 */
export function wallScene(world: World, terminals: Set<SceneTerminal>, params: URLSearchParams) {
  const maxLayers = Math.min(MAX_COMPOSITION_LAYERS, Number(params.get('layers') ?? MAX_COMPOSITION_LAYERS));

  let tree: LathTree = leafTree('a');
  for (const [at, edge, id] of [
    ['a', 'right', 'b'],
    ['b', 'right', 'c'],
    ['a', 'bottom', 'd'],
    ['c', 'bottom', 'e'],
    ['e', 'right', 'f'],
  ] as const) {
    tree = split(tree, at, edge, id).tree;
  }

  const panes = new Map<LeafId, WallPane>();
  let created = 0;

  // `?source=canned`: the panes show a PaneSource's surfaces instead of local echo shells, one
  // attached (streaming) at a time as over protocol-v1; pressing a pane attaches it.
  const source: PaneSource | null = params.get('source') === 'canned' ? cannedSource(leaves(tree).length) : null;
  const surfaceOf = new Map(leaves(tree).map((id, i) => [id, source?.getDirectoryEntries()[i]?.surfaceId ?? id]));
  let attachedId: LeafId | null = null;
  const attach = (pane: WallPane) => {
    if (!source || attachedId === pane.id) return;
    const previous = attachedId ? panes.get(attachedId) : undefined;
    attachedId = pane.id;
    previous?.redrawHeader();
    pane.redrawHeader();
    void source.setActivePane(surfaceOf.get(pane.id)!, pane.terminal.term.cols, pane.terminal.term.rows);
  };
  source?.onPtyData(({ id, data }, claim) => {
    const pane = [...panes.values()].find((p) => surfaceOf.get(p.id) === id);
    pane?.terminal.term.write(data, claim?.());
  });

  function createPane(id: LeafId): WallPane {
    const kind = created++ < maxLayers ? 'layer' : 'mesh';
    const terminal = createSceneTerminal({ cols: 40, rows: 10, fontSize: 14 });
    terminals.add(terminal);
    const entry = source?.getDirectoryEntries().find((e) => e.surfaceId === surfaceOf.get(id));
    if (source) {
      // Local until the first attach repaints the screen, so the pane draws a frame at all.
      terminal.term.write(`\x1b[90m${entry?.title ?? id} · press to attach\x1b[0m`);
      terminal.term.onData((data) => source.writePty(surfaceOf.get(id)!, data));
    } else {
      terminal.term.write(
        id === 'a' ? demoContent() : `\x1b[1;38;2;120;220;120mpane ${id}\x1b[0m \x1b[90m· ${kind === 'layer' ? 'XRCylinderLayer' : 'mesh (past the layer budget)'}\x1b[0m`,
      );
      attachEchoShell(terminal.term);
    }

    const headerLabel = labelTexture();
    const header = new Mesh(arcGeometry({ x: 0, y: 0, width: 1, height: 1 }), new MeshBasicMaterial({ map: headerLabel.texture, side: BackSide, toneMapped: false }));
    world.createTransformEntity(header).addComponent(RayInteractable);

    let body: Object3D;
    let layerEntity: Entity | null = null;
    let bodyMesh: Mesh | null = null;
    let inScene: InSceneText | null = null;
    if (kind === 'layer') {
      // The layer draws the terminal texture full-frame; iWSDK reads its render target top-down
      // (see the compare scene), and its cylinder fallback mirrors u the way arcGeometry corrects.
      const layerScene = new Scene();
      const plane = new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial({ map: terminal.texture, toneMapped: false }));
      plane.scale.set(-1, -1, 1);
      layerScene.add(plane);
      const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
      layerEntity = world.createTransformEntity();
      layerEntity.addComponent(XRCylinderLayer, {
        radius: RADIUS_M,
        renderCallback: () => {
          (plane.material as MeshBasicMaterial).map = terminal.texture;
          world.renderer.render(layerScene, camera);
        },
      });
      layerEntity.addComponent(RayInteractable);
      body = layerEntity.object3D!;
    } else {
      // A mesh pane draws the fork's scene frames in the scene when the addon has them, over an
      // invisible ray target; otherwise the canvas texture.
      const frames = params.get('inscene') === '0' ? null : sceneFrames(terminal.addon);
      bodyMesh = new Mesh(
        arcGeometry({ x: 0, y: 0, width: 1, height: 1 }),
        frames
          ? new MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: BackSide })
          : new MeshBasicMaterial({ map: terminal.texture, side: BackSide, toneMapped: false }),
      );
      if (frames) {
        inScene = new InSceneText(frames);
        bodyMesh.add(inScene.object);
      }
      world.createTransformEntity(bodyMesh).addComponent(RayInteractable);
      body = bodyMesh;
    }

    let headerWidth = 1;
    const pane: WallPane = {
      id,
      terminal,
      kind,
      termRect: { x: 0, y: 0, width: 1, height: 1 },
      header,
      body,
      redrawHeader() {
        const how = kind === 'layer' ? 'layer' : inScene ? 'in-scene SDF' : 'mesh';
        const what = entry ? `${entry.title} · ${attachedId === id ? 'attached' : 'detached'}` : id;
        headerLabel.draw(headerWidth, HEADER_PX, (ctx) => {
          ctx.fillStyle = attachedId === id ? '#2f4a3a' : '#2a3442';
          ctx.fillRect(0, 0, headerWidth, HEADER_PX);
          ctx.fillStyle = '#c8d0e0';
          ctx.font = '15px system-ui, sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${what} · ${how} · ${terminal.term.cols}×${terminal.term.rows}`, 10, HEADER_PX / 2);
        });
      },
      place(rect) {
        const termRect = { x: rect.x, y: rect.y + HEADER_PX, width: rect.width, height: Math.max(1, rect.height - HEADER_PX) };
        pane.termRect = termRect;
        const cell = terminal.cellSize();
        const cols = Math.max(2, Math.floor(termRect.width / cell.width));
        const rows = Math.max(1, Math.floor(termRect.height / cell.height));
        if (cols !== terminal.term.cols || rows !== terminal.term.rows) {
          terminal.term.resize(cols, rows);
          if (source && attachedId === id) source.resizePty(surfaceOf.get(id)!, cols, rows);
        }

        placeArc(header, { x: rect.x, y: rect.y, width: rect.width, height: HEADER_PX });
        headerWidth = rect.width;
        pane.redrawHeader();

        if (bodyMesh) {
          placeArc(bodyMesh, termRect);
          inScene?.setSurface({
            kind: 'arc',
            radius: RADIUS_M,
            angle0: angleOf(termRect.x),
            angle1: angleOf(termRect.x + termRect.width),
            height: termRect.height * M_PER_PX,
          });
        }
        if (layerEntity) {
          const a0 = angleOf(termRect.x);
          const a1 = angleOf(termRect.x + termRect.width);
          const object = layerEntity.object3D!;
          object.position.set(0, heightOf(termRect.y + termRect.height / 2), 0);
          object.rotation.y = -(a0 + a1) / 2;
          layerEntity.setValue(XRCylinderLayer, 'centralAngle', a1 - a0);
          layerEntity.setValue(XRCylinderLayer, 'aspectRatio', termRect.width / termRect.height);
          layerEntity.setValue(XRCylinderLayer, 'pixelWidth', Math.round(termRect.width));
          layerEntity.setValue(XRCylinderLayer, 'pixelHeight', Math.round(termRect.height));
        }
      },
    };

    const fractionOf = (e: PointerHit): Fraction => {
      const p = rayWallPoint(e);
      const r = pane.termRect;
      return { fx: clamp01((p.x - r.x) / r.width), fy: clamp01((p.y - r.y) / r.height) };
    };
    attachPaneInput(body, fractionOf, terminal.term, {
      onPointer: (kind) => {
        if (kind === 'down') attach(pane);
      },
    });
    attachHeaderDrag(pane);
    return pane;
  }

  // Sashes: one ray target per adjacent pair, keyed by split path and boundary so a drag keeps its
  // object (and pointer capture) while the tree it previews changes.
  const sashMeshes = new Map<string, { mesh: Mesh; entity: Entity }>();
  const sashMaterial = new MeshBasicMaterial({ color: 0x4a5a6a, side: BackSide, transparent: true, opacity: 0.55, toneMapped: false });
  const sashKey = (s: { splitPath: number[]; boundary: number }) => `${s.splitPath.join('.')}:${s.boundary}`;
  let sashDrag: { key: string; pointerId: number; start: Point; tree: LathTree; preview: LathTree } | null = null;

  // The drop preview for a header drag.
  const preview = new Mesh(arcGeometry({ x: 0, y: 0, width: 1, height: 1 }), new MeshBasicMaterial({ color: 0x8ab4f8, side: BackSide, transparent: true, opacity: 0.3, toneMapped: false, depthWrite: false }));
  preview.visible = false;
  preview.raycast = () => {};
  world.scene.add(preview);
  let paneDrag: { id: LeafId; pointerId: number; candidate: DropCandidate | null } | null = null;

  function render(shown: LathTree) {
    const rects = layout(shown, WALL, OPTS);
    for (const id of leaves(shown)) {
      const pane = panes.get(id) ?? createPane(id);
      panes.set(id, pane);
      pane.place(rects.get(id)!);
    }
    const live = new Set<string>();
    for (const s of sashes(shown, WALL, OPTS)) {
      const key = sashKey(s);
      live.add(key);
      let mesh = sashMeshes.get(key)?.mesh;
      if (!mesh) {
        mesh = new Mesh(arcGeometry({ x: 0, y: 0, width: 1, height: 1 }), sashMaterial);
        const entity = world.createTransformEntity(mesh).addComponent(RayInteractable);
        attachSashDrag(mesh, key);
        sashMeshes.set(key, { mesh, entity });
      }
      mesh.userData.sash = s;
      const grow = (SASH_HIT_PX - OPTS.gap) / 2;
      const r = s.dir === 'row'
        ? { x: s.rect.x - grow, y: s.rect.y, width: s.rect.width + 2 * grow, height: s.rect.height }
        : { x: s.rect.x, y: s.rect.y - grow, width: s.rect.width, height: s.rect.height + 2 * grow };
      placeArc(mesh, r, 0.002);
    }
    // Three's raycaster ignores `visible`, so a sash the new tree lacks must go, not hide; the one
    // under a drag stays until release, keeping its pointer capture.
    for (const [key, { mesh, entity }] of sashMeshes) {
      if (live.has(key) || sashDrag?.key === key) continue;
      mesh.geometry.dispose();
      entity.destroy();
      sashMeshes.delete(key);
    }
  }

  function attachSashDrag(mesh: Mesh, key: string) {
    onPointer(mesh, {
      pointerdown: (e) => {
        if (sashDrag || paneDrag) return;
        e.target.setPointerCapture?.(e.pointerId);
        sashDrag = { key, pointerId: e.pointerId, start: rayWallPoint(e), tree, preview: tree };
      },
      pointermove: (e) => {
        if (sashDrag?.key !== key || e.pointerId !== sashDrag.pointerId) return;
        const s = mesh.userData.sash as ReturnType<typeof sashes>[number];
        const p = rayWallPoint(e);
        const delta = s.dir === 'row' ? p.x - sashDrag.start.x : p.y - sashDrag.start.y;
        const r = resize(sashDrag.tree, s.splitPath, s.boundary, delta, WALL, OPTS);
        if (r.ok) {
          sashDrag.preview = r.tree;
          render(r.tree);
        }
      },
      pointerup: (e) => {
        if (sashDrag?.key !== key || e.pointerId !== sashDrag.pointerId) return;
        e.target.releasePointerCapture?.(e.pointerId);
        tree = sashDrag.preview;
        sashDrag = null;
        render(tree);
      },
    });
  }

  function attachHeaderDrag(pane: WallPane) {
    onPointer(pane.header, {
      pointerdown: (e) => {
        if (sashDrag || paneDrag) return;
        e.target.setPointerCapture?.(e.pointerId);
        paneDrag = { id: pane.id, pointerId: e.pointerId, candidate: null };
      },
      pointermove: (e) => {
        if (paneDrag?.id !== pane.id || e.pointerId !== paneDrag.pointerId) return;
        // Hit-tested against the live tree each move, as the HTML adapter does.
        paneDrag.candidate = hitTest(tree, WALL, rayWallPoint(e), pane.id, OPTS).candidate;
        preview.visible = paneDrag.candidate !== null;
        if (paneDrag.candidate) placeArc(preview, paneDrag.candidate.previewRect, 0.004);
      },
      pointerup: (e) => {
        if (paneDrag?.id !== pane.id || e.pointerId !== paneDrag.pointerId) return;
        e.target.releasePointerCapture?.(e.pointerId);
        const { candidate } = paneDrag;
        paneDrag = null;
        preview.visible = false;
        if (!candidate) return;
        const r = move(tree, pane.id, candidate.target);
        if (r.ok) {
          tree = r.tree;
          render(tree);
        }
      },
    });
  }

  render(tree);
  if (source) attach(panes.get(leaves(tree)[0])!);

  return {
    wall: {
      get tree() {
        return tree;
      },
      rects: () => layout(tree, WALL, OPTS),
      sashes: () => sashes(tree, WALL, OPTS),
      panes,
      /** World target for wall px, a hair in front of the wall, for IWER's `look_at`. */
      point: (x: number, y: number) => {
        const { x: wx, y: wy, z } = worldPoint(x, y, 0.001);
        return { x: wx, y: wy, z };
      },
    },
  };
}
