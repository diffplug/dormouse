import { createSystem, World } from '@iwsdk/core';
import { GridHelper } from 'three';
import { compareScene } from './compare-scene';
import type { SceneTerminal } from './terminal';
import { wallScene } from './wall-scene';

const container = document.getElementById('scene');
if (!(container instanceof HTMLDivElement)) throw new Error('#scene is missing');

const world = await World.create(container, {
  xr: { offer: 'none', features: { layers: { required: false } } },
  render: { camera: { position: [0, 1.6, 0], lookAt: [0, 1.5, -1.5] } },
  features: { spatialUI: false },
});
world.scene.add(new GridHelper(10, 20, 0x3a4a5a, 0x22303c));

const terminals = new Set<SceneTerminal>();
world.registerSystem(
  class TerminalTextureSystem extends createSystem() {
    update() {
      const now = performance.now();
      for (const terminal of terminals) terminal.tick(now);
    }
  },
);

const params = new URLSearchParams(location.search);
const scene = params.get('scene') === 'compare' ? compareScene(world, terminals) : wallScene(world, terminals, params);

// Read by the emulator checks (canopy/README.md): `canopyXR.world.launchXR()` enters the emulated
// session, and each scene's handles give IWER's remote `look_at` its targets.
Object.assign(window, { canopyXR: { world, ...scene } });
