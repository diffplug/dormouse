/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalPane } from './TerminalPane';
import { LathHost } from './wall/LathHost';
import { createLathWallEngine, terminalLeafMeta, type LathWallEngine } from './wall/lath-wall-engine';
import { createLathWallStore, type LathWallStore } from './wall/lath-wall-store';
import { leaf, split, tree } from '../lib/lath/test-util';
import { PANE_HEADER_HEIGHT_PX } from './design';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const registry = vi.hoisted(() => ({
  entries: new Map<string, { cols: number; rows: number; container?: HTMLElement }>(),
  resizes: [] as Array<{ id: string; cols: number; rows: number }>,
  fits: vi.fn(),
}));
vi.mock('../lib/terminal-registry', () => ({
  UNNAMED_PANEL_TITLE: 'Terminal',
  getOrCreateTerminal: (id: string) => {
    if (!registry.entries.has(id)) registry.entries.set(id, { cols: 80, rows: 30 });
  },
  mountElement: (id: string, container: HTMLElement) => {
    registry.entries.get(id)!.container = container;
  },
  unmountElement: (id: string) => { registry.entries.get(id)!.container = undefined; },
  focusSession: vi.fn(),
  refitSession: (id: string) => {
    registry.fits(id);
    const entry = registry.entries.get(id)!;
    const rect = entry.container!.getBoundingClientRect();
    const cols = Math.max(2, Math.floor(rect.width / 10));
    const rows = Math.max(1, Math.floor(rect.height / 20));
    // Match xterm's unchanged-grid no-op; the assertions cover the sizes that
    // reach fitting, while this records the PTY-visible grid transitions.
    if (entry.cols === cols && entry.rows === rows) return;
    entry.cols = cols;
    entry.rows = rows;
    registry.resizes.push({ id, cols, rows });
  },
}));
vi.mock('./wall/AlertSpeechIndicator', () => ({ AlertSpeechIndicator: () => null }));
vi.mock('./SelectionOverlay', () => ({ SelectionOverlay: () => null }));
vi.mock('./SelectionPopup', () => ({ SelectionPopup: () => null }));
vi.mock('./wall/MouseOverrideBanner', () => ({ MouseOverrideBanner: () => null }));

let root: Root;
let container: HTMLElement;
let store: LathWallStore;
let engine: LathWallEngine;
let hostWidth: number;
let rafs: Map<number, FrameRequestCallback>;
let nextRaf: number;
let observers: Set<{ callback: ResizeObserverCallback; elements: Map<Element, { width: number; height: number } | null> }>;

beforeEach(() => {
  vi.useFakeTimers();
  registry.entries.clear();
  registry.resizes.length = 0;
  registry.fits.mockClear();
  hostWidth = 800;
  rafs = new Map();
  nextRaf = 0;
  observers = new Set();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafs.set(++nextRaf, cb);
    return nextRaf;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => rafs.delete(id));
  vi.stubGlobal('ResizeObserver', class {
    elements = new Map<Element, { width: number; height: number } | null>();
    constructor(readonly callback: ResizeObserverCallback) { observers.add(this); }
    observe(el: Element) { this.elements.set(el, null); }
    disconnect() { observers.delete(this); }
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const pane = this.closest<HTMLElement>('[data-lath-leaf]');
    const width = pane ? parseFloat(pane.style.width) : hostWidth;
    const height = pane ? Math.max(0, parseFloat(pane.style.height) - PANE_HEADER_HEIGHT_PX) : 600;
    return { x: 0, y: 0, width, height, top: 0, left: 0, right: width, bottom: height, toJSON() {} } as DOMRect;
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  store = createLathWallStore();
  store.seed(tree(split('row', [leaf('a'), 0.5], [leaf('b'), 0.5])), [
    ['a', terminalLeafMeta()], ['b', terminalLeafMeta()],
  ]);
  engine = createLathWallEngine(store, { durationMs: 440 });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function notifyResize() {
  act(() => {
    for (const observer of [...observers]) {
      const entries: ResizeObserverEntry[] = [];
      for (const [target, previous] of observer.elements) {
        const contentRect = target.getBoundingClientRect();
        if (previous?.width === contentRect.width && previous.height === contentRect.height) continue;
        observer.elements.set(target, { width: contentRect.width, height: contentRect.height });
        entries.push({ target, contentRect } as ResizeObserverEntry);
      }
      if (entries.length) observer.callback(entries, observer as unknown as ResizeObserver);
    }
  });
}
function frame(ms = 16) {
  act(() => {
    vi.advanceTimersByTime(ms);
    const callbacks = [...rafs.values()];
    rafs.clear();
    for (const cb of callbacks) cb(performance.now());
  });
  notifyResize();
}
function settle() {
  for (let i = 0; i < 30; i++) frame();
  act(() => vi.advanceTimersByTime(200));
}
function mount() {
  act(() => root.render(<LathHost lath={engine}
    onCommitResize={(path, boundary, delta) => { store.resizeBoundary(path, boundary, delta); }}
    componentsOverride={{ bodies: { terminal: ({ id }) => <TerminalPane id={id} /> }, tabs: { terminal: () => null } }}
  />));
  settle();
  registry.resizes.length = 0;
  registry.fits.mockClear();
}
function pointer(target: EventTarget, type: string, x: number) {
  act(() => target.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: 100 })));
}
function sashDrag() {
  pointer(container.querySelector('[data-lath-sash]')!, 'pointerdown', 400);
  pointer(window, 'pointermove', 500);
  frame();
}

describe('terminal fitting follows settled layout, not animated geometry', () => {
  it('reattaches the same terminal at the same size without a PTY resize', () => {
    mount();
    const terminal = registry.entries.get('b');
    let token: ReturnType<LathWallStore['doorLeaf']>['token'];
    act(() => { token = store.doorLeaf('b').token; });
    settle();
    registry.resizes.length = 0;
    registry.fits.mockClear();
    act(() => { store.restoreLeaf(terminalLeafMeta(), token!); });
    for (let i = 0; i < 20; i++) frame();
    expect(registry.fits).not.toHaveBeenCalled();
    settle();
    expect(registry.entries.get('b')).toBe(terminal);
    expect(registry.resizes.filter(e => e.id === 'b')).toEqual([]);
  });

  it('reattaches at a changed size with one final grid transition', () => {
    mount();
    let token: ReturnType<LathWallStore['doorLeaf']>['token'];
    act(() => { token = store.doorLeaf('b').token; });
    settle();
    hostWidth = 1200;
    notifyResize();
    settle();
    registry.resizes.length = 0;
    registry.fits.mockClear();
    act(() => { store.restoreLeaf(terminalLeafMeta(), token!); });
    for (let i = 0; i < 20; i++) frame();
    expect(registry.fits).not.toHaveBeenCalled();
    settle();
    expect(registry.resizes.filter(e => e.id === 'b')).toEqual([{ id: 'b', cols: 59, rows: 28 }]);
  });

  it('does not fit a delayed or interrupted zoom until its final frame is painted', () => {
    mount();
    act(() => store.setZoomed('b'));
    frame(100);
    // A long gap without a painted frame is not animation settlement.
    act(() => vi.advanceTimersByTime(1000));
    notifyResize();
    act(() => vi.advanceTimersByTime(200));
    expect(registry.fits).not.toHaveBeenCalled();
    act(() => store.setZoomed(null));
    for (let i = 0; i < 20; i++) frame();
    expect(registry.fits).not.toHaveBeenCalled();
    settle();
    expect(registry.resizes).toEqual([]);
  });

  it('fits a completed zoom once', () => {
    mount();
    act(() => store.setZoomed('b'));
    settle();
    expect(registry.resizes).toEqual([{ id: 'b', cols: 77, rows: 27 }]);
  });

  it('ignores stalled sash previews and cancellation', () => {
    mount();
    sashDrag();
    act(() => vi.advanceTimersByTime(1000));
    expect(registry.fits).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    settle();
    expect(registry.resizes).toEqual([]);
  });

  it('fits the committed sash size once', () => {
    mount();
    sashDrag();
    expect(registry.fits).not.toHaveBeenCalled();
    pointer(window, 'pointerup', 500);
    settle();
    expect(registry.resizes).toEqual([
      { id: 'a', cols: 49, rows: 28 }, { id: 'b', cols: 29, rows: 28 },
    ]);
  });

  it('fits the final sash commit when pointerup beats the last preview frame', () => {
    mount();
    sashDrag();
    pointer(window, 'pointermove', 600);
    pointer(window, 'pointerup', 600);
    settle();
    expect(registry.resizes).toEqual([
      { id: 'a', cols: 59, rows: 28 }, { id: 'b', cols: 19, rows: 28 },
    ]);
  });

  it('does not fit dying panes or run delayed fitting after unmount', () => {
    mount();
    act(() => engine.markDying('b', { shrinkTowardBottomRight: true }));
    settle();
    expect(registry.resizes.filter(e => e.id === 'b')).toEqual([]);
    notifyResize();
    registry.fits.mockClear();
    act(() => root.render(null));
    settle();
    expect(registry.fits).not.toHaveBeenCalled();
  });

  it('still fits a terminal outside Lath and coalesces container resizes', () => {
    act(() => root.render(<TerminalPane id="standalone" />));
    settle();
    registry.resizes.length = 0;
    hostWidth = 900;
    notifyResize();
    act(() => vi.advanceTimersByTime(100));
    hostWidth = 1000;
    notifyResize();
    act(() => vi.advanceTimersByTime(150));
    expect(registry.resizes).toEqual([{ id: 'standalone', cols: 100, rows: 30 }]);
  });
});
