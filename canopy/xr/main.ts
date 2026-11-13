import { World } from '@iwsdk/core';
import { GridHelper } from 'three';

const container = document.getElementById('scene');
if (!(container instanceof HTMLDivElement)) throw new Error('#scene is missing');

const world = await World.create(container, {
  xr: { offer: 'none', features: { layers: { required: false } } },
  render: { camera: { position: [0, 1.6, 0], lookAt: [0, 1.4, -1.5] } },
  features: { spatialUI: false },
});
world.scene.add(new GridHelper(10, 20, 0x3a4a5a, 0x22303c));

// Read by the emulator checks: `window.canopyXR.world.launchXR()` enters the emulated session.
Object.assign(window, { canopyXR: { world } });
