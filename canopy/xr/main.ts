import { createSystem, RayInteractable, World, XRQuadLayer } from '@iwsdk/core';
import {
  CanvasTexture,
  GridHelper,
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
import { attachPaneInput } from './input';
import { createSceneTerminal } from './terminal';

const container = document.getElementById('scene');
if (!(container instanceof HTMLDivElement)) throw new Error('#scene is missing');

const world = await World.create(container, {
  xr: { offer: 'none', features: { layers: { required: false } } },
  render: { camera: { position: [0, 1.6, 0], lookAt: [0, 1.4, -1.5] } },
  features: { spatialUI: false },
});
world.scene.add(new GridHelper(10, 20, 0x3a4a5a, 0x22303c));

const terminal = createSceneTerminal({ cols: 100, rows: 24, fontSize: 14 });
terminal.term.write(demoContent());
attachEchoShell(terminal.term);
world.registerSystem(
  class TerminalTextureSystem extends createSystem() {
    update() {
      terminal.tick(performance.now());
    }
  },
);

const PANE_WIDTH_M = 1.1;
const PANE_Y = 1.75;
const PANE_Z = -1.4;
const paneHeight = () => (PANE_WIDTH_M * terminal.pixelHeight) / terminal.pixelWidth;

/** Left: the terminal canvas as an ordinary mesh texture, resampled by the scene's own shader. */
const meshPane = new Mesh(
  new PlaneGeometry(PANE_WIDTH_M, paneHeight()),
  new MeshBasicMaterial({ map: terminal.texture, toneMapped: false }),
);
meshPane.position.set(-0.6, PANE_Y, PANE_Z);
meshPane.rotation.y = 0.2;
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
layerEntity.object3D!.position.set(0.6, PANE_Y, PANE_Z);
layerEntity.object3D!.rotation.y = -0.2;
layerEntity.addComponent(RayInteractable);

/** A one-line caption under a pane; returns a setter for its text. */
function caption(text: string, x: number, rotationY: number, row = 0): (text: string) => void {
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
  mesh.position.set(x, PANE_Y - paneHeight() / 2 - 0.06 - row * 0.07, PANE_Z);
  mesh.rotation.y = rotationY;
  world.scene.add(mesh);
  return draw;
}
caption('mesh texture (scene shader)', -0.6, 0.2);
caption('XRQuadLayer (compositor; IWER: fallback mesh)', 0.6, -0.2);

// Both panes take the controller ray as the terminal's mouse; the status line under the mesh pane
// reports where the ray lands and what xterm selected.
const status = caption('point a controller at either pane', -0.6, 0.2, 1);
for (const pane of [meshPane, layerEntity.object3D!]) {
  attachPaneInput(pane, () => ({ width: PANE_WIDTH_M, height: paneHeight() }), terminal.term, {
    onPointer: (kind, { col, row }) => {
      if (kind !== 'move') status(`mouse${kind} → col ${col}, row ${row}`);
    },
  });
}
terminal.term.onSelectionChange(() => {
  const text = terminal.term.getSelection().trim();
  if (text) status(`selected: "${text}"`);
});

const panes = { mesh: meshPane, layer: layerEntity.object3D! };

/** World-space center of a viewport cell on a pane, for aiming the emulated controller. */
function cellPoint(pane: keyof typeof panes, col: number, row: number) {
  const { term } = terminal;
  const local = new Vector3(((col + 0.5) / term.cols - 0.5) * PANE_WIDTH_M, (0.5 - (row + 0.5) / term.rows) * paneHeight(), 0);
  const { x, y, z } = panes[pane].localToWorld(local);
  return { x, y, z };
}

// Read by the emulator checks (canopy/README.md): `canopyXR.world.launchXR()` enters the emulated
// session, and `cellPoint` gives IWER's remote `look_at` a target.
Object.assign(window, { canopyXR: { world, terminal, cellPoint } });
