/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { TerminalWebglRenderer } from './terminal-webgl';
import { cfg } from '../cfg';

const state = vi.hoisted(() => ({
  addons: [] as Array<{ fireLoss(): void; dispose: ReturnType<typeof vi.fn>; lost: boolean; canvas: HTMLCanvasElement }>,
  order: [] as string[],
  failLoad: false,
  extension: true,
  exposeCanvas: true,
  probeFails: false,
  /** The addon's 2D link canvas refuses the probe instead of answering null. */
  linkProbeThrows: false,
  disposeThrows: false,
  loseThrows: false,
  contexts: new Map<HTMLCanvasElement, object | null | 'throws'>(),
}));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    lost = false;
    canvas = document.createElement('canvas');
    private loss: (() => void) | undefined;
    constructor() { state.addons.push(this); }
    onContextLoss(callback: () => void) { this.loss = callback; }
    fireLoss() { this.loss?.(); }
    activate(host: HTMLElement) {
      // Match the pinned addon: a new 2D link canvas and a WebGL canvas, both
      // initialized synchronously. Existing image canvases belong to other addons.
      const link = document.createElement('canvas');
      state.contexts.set(link, state.linkProbeThrows ? 'throws' : null);
      const gl = {
        isContextLost: () => this.lost,
        getExtension: (name: string) => {
          expect(name).toBe('WEBGL_lose_context');
          if (!state.extension) return null;
          return { loseContext: () => {
            state.order.push('lose');
            if (state.loseThrows) throw new Error('lose failed');
            this.lost = true;
          } };
        },
      };
      state.contexts.set(this.canvas, gl);
      host.append(link);
      if (state.exposeCanvas) host.append(this.canvas);
      if (state.failLoad) throw new Error('activation failed');
    }
    dispose = vi.fn(() => {
      state.order.push('dispose');
      this.canvas.remove();
      if (state.disposeThrows) throw new Error('dispose failed');
      // Keep fireLoss callable to simulate an already queued stale event.
    });
  },
}));

let host: HTMLDivElement;
let terminal: Terminal;
let renderer: TerminalWebglRenderer;
let previousEnabled: boolean;
let getContext: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.addons.length = 0;
  state.order.length = 0;
  state.contexts.clear();
  state.failLoad = false;
  state.extension = true;
  state.exposeCanvas = true;
  state.probeFails = false;
  state.linkProbeThrows = false;
  state.disposeThrows = false;
  state.loseThrows = false;
  previousEnabled = cfg.terminal.webglRenderer;
  cfg.terminal.webglRenderer = true;
  vi.stubGlobal('WebGL2RenderingContext', class {});
  getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    if (state.probeFails) throw new Error('Context probe failed');
    const context = state.contexts.get(this);
    if (context === undefined) throw new Error('Probed a canvas not initialized by the WebGL addon');
    if (context === 'throws') throw new Error('Context probe failed');
    return context as WebGL2RenderingContext | null;
  });
  host = document.createElement('div');
  document.body.append(host);
  terminal = {
    loadAddon: vi.fn((addon: { activate(host: HTMLElement): void }) => addon.activate(host)),
    resize: vi.fn(),
    dispose: vi.fn(),
  } as unknown as Terminal;
  renderer = new TerminalWebglRenderer(terminal, host);
});
afterEach(() => {
  renderer.unmount();
  host.remove();
  cfg.terminal.webglRenderer = previousEnabled;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('mount-scoped terminal WebGL resources', () => {
  it('acquires once per mount and releases the context after addon disposal', () => {
    expect(state.addons).toHaveLength(0);
    renderer.mount();
    renderer.mount();
    expect(state.addons).toHaveLength(1);
    expect(host.dataset.renderer).toBe('webgl');
    renderer.unmount();
    expect(state.order).toEqual(['dispose', 'lose']);
    expect(state.addons[0].lost).toBe(true);
    expect(host.dataset.renderer).toBe('dom');
    renderer.unmount();
    expect(state.order).toEqual(['dispose', 'lose']);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(terminal.resize).not.toHaveBeenCalled();
  });

  it('reclaims a fresh context without letting old loss events dispose it', () => {
    renderer.mount();
    const old = state.addons[0];
    renderer.unmount();
    renderer.mount();
    expect(state.addons).toHaveLength(2);
    const current = state.addons[1];
    old.fireLoss();
    expect(current.dispose).not.toHaveBeenCalled();
    expect(current.lost).toBe(false);
    expect(host.dataset.renderer).toBe('webgl');
    expect(terminal.resize).not.toHaveBeenCalled();
  });

  it('falls back on context loss and retries only after another unmount/mount', () => {
    renderer.mount();
    const old = state.addons[0];
    old.lost = true;
    old.fireLoss();
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(state.order).toEqual(['dispose']);
    expect(host.dataset.renderer).toBe('dom');
    renderer.mount();
    expect(state.addons).toHaveLength(1);
    renderer.unmount();
    renderer.mount();
    expect(state.addons).toHaveLength(2);
    expect(host.dataset.renderer).toBe('webgl');
  });

  it.each(['disabled', 'unavailable'])('keeps DOM when WebGL is %s', reason => {
    if (reason === 'disabled') cfg.terminal.webglRenderer = false;
    else vi.stubGlobal('WebGL2RenderingContext', undefined);
    renderer.mount();
    expect(state.addons).toHaveLength(0);
    expect(getContext).not.toHaveBeenCalled();
    expect(host.dataset.renderer).toBe('dom');
  });

  it('releases a context created before activation fails and does not retry in place', () => {
    state.failLoad = true;
    state.disposeThrows = true;
    expect(() => renderer.mount()).not.toThrow();
    expect(state.order).toEqual(['dispose', 'lose']);
    expect(host.dataset.renderer).toBe('dom');
    renderer.mount();
    expect(state.addons).toHaveLength(1);
    state.failLoad = false;
    state.disposeThrows = false;
    renderer.unmount();
    renderer.mount();
    expect(host.dataset.renderer).toBe('webgl');
  });

  it.each(['extension unavailable', 'canvas missing', 'probe throws'])('keeps healthy WebGL when %s', reason => {
    if (reason === 'extension unavailable') state.extension = false;
    if (reason === 'canvas missing') state.exposeCanvas = false;
    if (reason === 'probe throws') state.probeFails = true;
    renderer.mount();
    expect(state.addons[0].dispose).not.toHaveBeenCalled();
    expect(host.dataset.renderer).toBe('webgl');
    renderer.mount();
    expect(state.addons).toHaveLength(1);
    renderer.unmount();
    expect(state.addons[0].dispose).toHaveBeenCalledOnce();
    expect(state.order).toEqual(['dispose']);
    expect(host.dataset.renderer).toBe('dom');
  });

  it('keeps scanning past a canvas that refuses the probe', () => {
    state.linkProbeThrows = true;
    renderer.mount();
    expect(host.dataset.renderer).toBe('webgl');
    renderer.unmount();
    // The addon's own canvas is found behind the refusing one, so loss stays explicit.
    expect(state.order).toEqual(['dispose', 'lose']);
    expect(state.addons[0].lost).toBe(true);
  });

  it.each(['disposal', 'explicit loss'])('completes teardown when %s throws', which => {
    state.disposeThrows = which === 'disposal';
    state.loseThrows = which === 'explicit loss';
    renderer.mount();
    // A throwing release must not abort the caller's unmount/park/dispose teardown.
    expect(() => renderer.unmount()).not.toThrow();
    expect(state.order).toEqual(['dispose', 'lose']);
    expect(host.dataset.renderer).toBe('dom');
    state.disposeThrows = false;
    state.loseThrows = false;
    renderer.mount();
    expect(state.addons).toHaveLength(2);
    expect(host.dataset.renderer).toBe('webgl');
  });

  it('never probes or disposes a pre-existing image canvas', () => {
    const image = document.createElement('canvas');
    host.append(image);
    renderer.mount();
    renderer.unmount();
    expect(image.isConnected).toBe(true);
    expect(getContext.mock.contexts).not.toContain(image);
  });
});
