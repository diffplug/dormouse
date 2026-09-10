import type { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { cfg } from '../cfg';

/** One mounted terminal's renderer. The xterm, PTY, and other addons outlive it. */
export class TerminalWebglRenderer {
  private addon: WebglAddon | undefined;
  private loseContext: (() => void) | undefined;
  private attempted = false;

  constructor(private terminal: Terminal, private host: HTMLElement) {}

  mount(): void {
    // A failed or evicted renderer stays on DOM until a real unmount/remount;
    // focus and metadata updates must not compete repeatedly for context slots.
    if (this.attempted) return;
    this.attempted = true;
    this.markDom();
    if (!cfg.terminal.webglRenderer || typeof WebGL2RenderingContext === 'undefined') return;

    const existingCanvases = new Set(this.host.querySelectorAll('canvas'));
    try {
      const addon = new WebglAddon();
      this.addon = addon;
      addon.onContextLoss(() => {
        if (this.addon === addon) this.release();
      });
      try {
        this.terminal.loadAddon(addon);
      } finally {
        try {
          this.captureContext(existingCanvases);
        } catch {
          // Capture is best-effort across host capabilities and addon updates.
          // Keep a healthy renderer; disposal still frees its GPU objects, with
          // GC reclaiming the context slot if explicit loss is unavailable.
        }
      }
      this.host.setAttribute('data-renderer', 'webgl');
    } catch {
      this.release();
    }
  }

  unmount(): void {
    this.release();
    this.attempted = false;
  }

  private markDom(): void {
    this.host.setAttribute('data-renderer', 'dom');
  }

  private captureContext(existingCanvases: Set<HTMLCanvasElement>): void {
    // The pinned addon synchronously adds initialized WebGL and 2D link canvases
    // during activation. Read only its NEW canvases: getContext returns the
    // existing WebGL2 context (null for a canvas already initialized as 2D).
    // Never probe pre-existing ImageAddon canvases or the shared atlas canvas.
    // This avoids depending on the addon's private _renderer/_gl fields.
    for (const canvas of this.host.querySelectorAll('canvas')) {
      if (existingCanvases.has(canvas)) continue;
      const gl = canvas.getContext('webgl2');
      if (!gl) continue;
      const extension = gl.getExtension('WEBGL_lose_context');
      if (extension) {
        this.loseContext = () => {
          if (!gl.isContextLost()) extension.loseContext();
        };
      }
      return;
    }
  }

  private release(): void {
    const addon = this.addon;
    const loseContext = this.loseContext;
    this.addon = undefined;
    this.loseContext = undefined;
    try {
      // Dispose first: this drops the addon's context-loss listeners and its
      // atlas-cache ownership, and restores xterm's DOM renderer at the SAME grid.
      // Other compatible terminals keep the shared atlas alive.
      addon?.dispose();
    } finally {
      loseContext?.();
      this.markDom();
    }
  }
}
