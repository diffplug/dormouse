import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@diffplug/xterm-addon-webgl-sdf';
import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';
import '@xterm/xterm/css/xterm.css';

export interface SceneTerminal {
  term: Terminal;
  /** The addon's WebGL canvas, live; re-uploaded after every xterm render. */
  texture: CanvasTexture;
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
  // preserveDrawingBuffer: Three.js uploads the canvas on its own frame, after the browser may have
  // composited and cleared an unpreserved WebGL drawing buffer.
  term.loadAddon(new WebglAddon({ sdf: true, preserveDrawingBuffer: true }));

  const canvas = host.querySelector<HTMLCanvasElement>('.xterm-screen canvas:not(.xterm-link-layer)');
  if (!canvas) throw new Error('the webgl addon mounted no canvas');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  const onRender = term.onRender(() => {
    texture.needsUpdate = true;
  });

  return {
    term,
    texture,
    get pixelWidth() {
      return canvas.width;
    },
    get pixelHeight() {
      return canvas.height;
    },
    dispose() {
      onRender.dispose();
      texture.dispose();
      term.dispose();
      host.remove();
    },
  };
}
