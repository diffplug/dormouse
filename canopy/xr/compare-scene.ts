import { RayInteractable, XRQuadLayer, type World } from '@iwsdk/core';
import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { demoContent } from '../src/demo-content';
import { attachEchoShell } from './echo-shell';
import { attachPaneInput, planeFraction } from './input';
import { InSceneText, sceneFrames } from './in-scene-text';
import { createSceneTerminal, type SceneTerminal } from './terminal';

/**
 * `?scene=compare`: one SDF terminal drawn three ways — a mesh texture of its canvas, its scene
 * frames drawn in the scene (when the addon has them), and a quad layer — each taking the controller
 * ray as the terminal's mouse.
 */
export function compareScene(world: World, terminals: Set<SceneTerminal>, params: URLSearchParams) {
  const terminal = createSceneTerminal({ cols: 100, rows: 24, fontSize: 14 });
  terminals.add(terminal);
  terminal.term.write(demoContent());
  attachEchoShell(terminal.term);

  const PANE_WIDTH_M = 0.95;
  const SIDE_X = 1.05;
  const SIDE_TURN = 0.35;
  const PANE_Y = 1.75;
  const PANE_Z = -1.4;
  const paneHeight = () => (PANE_WIDTH_M * terminal.pixelHeight) / terminal.pixelWidth;

  /** Left: the terminal canvas as an ordinary mesh texture, resampled by the scene's own shader. */
  const meshPane = new Mesh(
    new PlaneGeometry(PANE_WIDTH_M, paneHeight()),
    new MeshBasicMaterial({ map: terminal.texture, toneMapped: false }),
  );
  meshPane.position.set(-SIDE_X, PANE_Y, PANE_Z + 0.15);
  meshPane.rotation.y = SIDE_TURN;
  world.createTransformEntity(meshPane).addComponent(RayInteractable);

  /**
   * Right: the same texture drawn into an iWSDK quad layer, which a headset's compositor samples
   * directly. Outside a layers-capable session (IWER included) iWSDK shows the layer's render target
   * on a fallback mesh, so the emulator proves only that both paths draw the same terminal.
   */
  const layerScene = new Scene();
  const layerCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const layerPlane = new Mesh(new PlaneGeometry(2, 2), new MeshBasicMaterial({ map: terminal.texture, toneMapped: false }));
  // iWSDK samples a layer's render target top-down (its fallback mesh flips v to match the native
  // layer), so the content is drawn flipped. Unconfirmed on a headset.
  layerPlane.scale.y = -1;
  layerScene.add(layerPlane);
  const layerEntity = world.createTransformEntity();
  layerEntity.addComponent(XRQuadLayer, {
    width: PANE_WIDTH_M,
    height: paneHeight(),
    pixelWidth: terminal.pixelWidth,
    pixelHeight: terminal.pixelHeight,
    renderCallback: () => world.renderer.render(layerScene, layerCamera),
  });
  layerEntity.object3D!.position.set(SIDE_X, PANE_Y, PANE_Z + 0.15);
  layerEntity.object3D!.rotation.y = -SIDE_TURN;

  /**
   * Center: the fork's scene frames drawn by the scene itself, over an invisible ray target. With
   * the released addon (no scene frames) or `?inscene=0` it shows the texture instead.
   */
  const frames = params.get('inscene') === '0' ? null : sceneFrames(terminal.addon);
  const scenePane = new Mesh(
    new PlaneGeometry(PANE_WIDTH_M, paneHeight()),
    frames ? new MeshBasicMaterial({ colorWrite: false, depthWrite: false }) : new MeshBasicMaterial({ map: terminal.texture, toneMapped: false }),
  );
  scenePane.position.set(0, PANE_Y, PANE_Z);
  world.createTransformEntity(scenePane).addComponent(RayInteractable);
  if (frames) {
    const text = new InSceneText(frames);
    text.setSurface({ kind: 'flat', width: PANE_WIDTH_M, height: paneHeight() });
    scenePane.add(text.object);
  }
  layerEntity.addComponent(RayInteractable);

  /** A one-line caption under a pane; returns a setter for its text. */
  function caption(text: string, x: number, rotationY: number, row = 0, z = PANE_Z): (text: string) => void {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 64;
    const ctx = canvas.getContext('2d')!;
    const texture = new CanvasTexture(canvas);
    const draw = (value: string) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = row ? '#f0c674' : '#8ab4f8';
      ctx.font = '36px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(value, 512, 32, 1000);
      texture.needsUpdate = true;
    };
    draw(text);
    texture.colorSpace = SRGBColorSpace;
    const mesh = new Mesh(
      new PlaneGeometry(PANE_WIDTH_M, PANE_WIDTH_M / 16),
      new MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false }),
    );
    mesh.position.set(x, PANE_Y - paneHeight() / 2 - 0.06 - row * 0.07, z);
    mesh.rotation.y = rotationY;
    world.scene.add(mesh);
    return draw;
  }
  caption('mesh texture of the canvas', -SIDE_X, SIDE_TURN, 0, PANE_Z + 0.15);
  caption(frames ? 'in-scene SDF (scene frames)' : 'in-scene SDF unavailable: texture', 0, 0);
  caption('XRQuadLayer (compositor; IWER: fallback mesh)', SIDE_X, -SIDE_TURN, 0, PANE_Z + 0.15);

  // Every pane takes the controller ray as the terminal's mouse; the status line under the center pane
  // reports where the ray lands and what xterm selected.
  const status = caption('point a controller at any pane', 0, 0, 1);
  for (const pane of [meshPane, scenePane, layerEntity.object3D!]) {
    attachPaneInput(pane, planeFraction(pane, () => ({ width: PANE_WIDTH_M, height: paneHeight() })), terminal.term, {
      onPointer: (kind, { col, row }) => {
        if (kind !== 'move') status(`mouse${kind} → col ${col}, row ${row}`);
      },
    });
  }
  terminal.term.onSelectionChange(() => {
    const text = terminal.term.getSelection().trim();
    if (text) status(`selected: "${text}"`);
  });

  const panes = { mesh: meshPane, scene: scenePane, layer: layerEntity.object3D! };

  /** World-space center of a viewport cell on a pane, for aiming the emulated controller. */
  function cellPoint(pane: keyof typeof panes, col: number, row: number) {
    const { term } = terminal;
    const local = new Vector3(((col + 0.5) / term.cols - 0.5) * PANE_WIDTH_M, (0.5 - (row + 0.5) / term.rows) * paneHeight(), 0);
    const { x, y, z } = panes[pane].localToWorld(local);
    return { x, y, z };
  }

  return { terminal, cellPoint };
}
