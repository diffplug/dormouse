import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@diffplug/xterm-addon-webgl-sdf';
import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';
import '@xterm/xterm/css/xterm.css';

export interface SceneTerminal {
  term: Terminal;
  /** A copy of the addon's WebGL canvas, refreshed by `tick` while xterm may be redrawing. */
  texture: CanvasTexture;
  /** Call once per scene frame. */
  tick(now: number): void;
  /** Canvas size in device pixels, for sizing meshes and layers. */
  pixelWidth: number;
  pixelHeight: number;
  dispose(): void;
}

/**
 * An xterm.js terminal rendered by the SDF addon whose canvas feeds a Three.js texture.
 *
 * The terminal stays in the DOM at the page's top-left under the opaque scene canvas: xterm pauses
 * rendering for an element its IntersectionObserver reports off-screen, so it must not be moved out
 * of the viewport or `display: none`d.
 */
export function createSceneTerminal(opts: { cols: number; rows: number; fontSize: number }): SceneTerminal {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;z-index:-1;pointer-events:none;';
  document.body.prepend(host);

  const term = new Terminal({
    cols: opts.cols,
    rows: opts.rows,
    fontSize: opts.fontSize,
    fontFamily: 'Menlo, Monaco, "DejaVu Sans Mono", Consolas, monospace',
    cursorBlink: false,
    theme: { background: '#16161e', foreground: '#c8d0e0' },
  });
  term.open(host);
  // preserveDrawingBuffer: the copy below runs on the scene's frame, after the browser may have
  // composited and cleared an unpreserved WebGL drawing buffer.
  term.loadAddon(new WebglAddon({ sdf: true, preserveDrawingBuffer: true }));

  const source = host.querySelector<HTMLCanvasElement>('.xterm-screen canvas:not(.xterm-link-layer)');
  if (!source) throw new Error('the webgl addon mounted no canvas');
  // Never texture the WebGL canvas directly: Chrome (measured 2026-11, in IWER) uploads another
  // context's canvas from its last composited frame, which never updates for a canvas hidden under
  // the scene. A 2D drawImage reads the live drawing buffer.
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const copy = () => {
    if (canvas.width !== source.width || canvas.height !== source.height) {
      canvas.width = source.width;
      canvas.height = source.height;
    }
    ctx.drawImage(source, 0, 0);
  };
  copy();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  // xterm redraws on its own animation frame and fires no onRender for a selection-only redraw, so
  // every change opens a short window of per-frame uploads instead of one upload per event.
  const DIRTY_MS = 150;
  let dirtyUntil = 0;
  const markDirty = () => {
    dirtyUntil = performance.now() + DIRTY_MS;
  };
  const subs = [term.onRender(markDirty), term.onSelectionChange(markDirty), term.onWriteParsed(markDirty)];

  return {
    term,
    texture,
    tick(now) {
      if (now >= dirtyUntil) return;
      copy();
      texture.needsUpdate = true;
    },
    get pixelWidth() {
      return canvas.width;
    },
    get pixelHeight() {
      return canvas.height;
    },
    dispose() {
      for (const sub of subs) sub.dispose();
      texture.dispose();
      term.dispose();
      host.remove();
    },
  };
}
