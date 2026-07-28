/**
 * @vitest-environment jsdom
 *
 * The focus ring's travel is a JS tween driven off a rAF loop (rect-tween.ts +
 * WorkspaceSelectionOverlay). jsdom has no layout, so each pane's element gets a
 * stubbed `getBoundingClientRect`; time and rAF are a controllable fake clock so
 * the tween is stepped deterministically without real timers.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceSelectionOverlay, type LathOverlayStore } from './WorkspaceSelectionOverlay';
import {
  DoorElementsContext,
  PaneElementsContext,
  WindowFocusedContext,
  type PaneElementsState,
} from './wall-context';
import type { WallMode } from './wall-types';
import { cfg } from '../../cfg';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Rectish = { top: number; left: number; width: number; height: number };

function stubRect(el: HTMLElement, r: Rectish): void {
  el.getBoundingClientRect = () => ({
    top: r.top, left: r.left, width: r.width, height: r.height,
    right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top,
    toJSON() {},
  }) as DOMRect;
}

/** A minimal Lath store: `commit()` bumps revision + notifies (the overlay
 *  re-measures on that signal via `useSyncExternalStore`). */
function makeStore() {
  let revision = 0;
  const listeners = new Set<() => void>();
  return {
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
    getSnapshot() { return { revision }; },
    commit() { revision++; for (const l of listeners) l(); },
  } satisfies LathOverlayStore & { commit(): void };
}

// Fake clock + rAF: performance.now reads `clock`; frames run only when we flush.
let clock = 0;
let rafSeq = 0;
let rafCbs: Map<number, FrameRequestCallback>;
let realNow: () => number;
let realRaf: typeof requestAnimationFrame;
let realCaf: typeof cancelAnimationFrame;

let container: HTMLDivElement;
let root: Root;

function paneCtx(elements: Map<string, HTMLElement>): PaneElementsState {
  return { elements, version: 0, bumpVersion: () => {} };
}

function Harness({ selectedId, mode, store, panes }: {
  selectedId: string | null;
  mode: WallMode;
  store: LathOverlayStore;
  panes: Map<string, HTMLElement>;
}) {
  return (
    <PaneElementsContext.Provider value={paneCtx(panes)}>
      <DoorElementsContext.Provider value={paneCtx(new Map())}>
        <WindowFocusedContext.Provider value={true}>
          <WorkspaceSelectionOverlay
            lathStore={store}
            subscribeLathFrames={null}
            selectedId={selectedId}
            selectedType="pane"
            mode={mode}
          />
        </WindowFocusedContext.Provider>
      </DoorElementsContext.Provider>
    </PaneElementsContext.Provider>
  );
}

/** The overlay's root (fixed-position) div, or null when the ring is hidden. */
function ring(): HTMLElement | null {
  return container.querySelector('div');
}
function ringRect() {
  const el = ring();
  if (!el) return null;
  return {
    top: parseFloat(el.style.top),
    left: parseFloat(el.style.left),
    width: parseFloat(el.style.width),
    height: parseFloat(el.style.height),
  };
}

/** Advance the clock and run the rAF callbacks queued as of now (ticks scheduled
 *  by those callbacks wait for the next flush). */
async function frame(ms: number): Promise<void> {
  clock += ms;
  const cbs = [...rafCbs.values()];
  rafCbs.clear();
  await act(async () => { for (const cb of cbs) cb(clock); });
}

function noReducedMotion() {
  globalThis.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, dispatchEvent() { return false; },
  })) as unknown as typeof matchMedia;
}

const A: Rectish = { top: 0, left: 0, width: 100, height: 40 };
const B: Rectish = { top: 200, left: 300, width: 160, height: 60 };
const INFLATE = 4; // SELECTION_RING_INFLATE_PX for panes

beforeEach(() => {
  clock = 0;
  rafSeq = 0;
  rafCbs = new Map();
  realNow = performance.now.bind(performance);
  realRaf = globalThis.requestAnimationFrame;
  realCaf = globalThis.cancelAnimationFrame;
  performance.now = () => clock;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = ++rafSeq;
    rafCbs.set(id, cb);
    return id;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => { rafCbs.delete(id); }) as typeof cancelAnimationFrame;
  globalThis.ResizeObserver ??= class {
    observe() {} unobserve() {} disconnect() {}
  } as unknown as typeof ResizeObserver;
  // The ants variant sizes its dash via SVG getTotalLength (unimplemented in jsdom).
  (SVGElement.prototype as unknown as { getTotalLength?: () => number }).getTotalLength ??= () => 100;
  noReducedMotion();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  // Some tests unmount explicitly (rAF-cancel coverage); a second unmount is a no-op.
  try { act(() => root.unmount()); } catch { /* already unmounted */ }
  container.remove();
  performance.now = realNow;
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCaf;
});

/** Two panes, `a` at rect A and `b` at rect B, both connected to the document. */
function twoPanes(): Map<string, HTMLElement> {
  const elA = document.createElement('div');
  const elB = document.createElement('div');
  stubRect(elA, A);
  stubRect(elB, B);
  document.body.append(elA, elB);
  return new Map([['a', elA], ['b', elB]]);
}

describe('WorkspaceSelectionOverlay ring travel', () => {
  it('tweens A→B through a strictly-intermediate rect, landing exactly on B', async () => {
    const store = makeStore();
    const panes = twoPanes();
    await act(async () => root.render(<Harness selectedId="a" mode="passthrough" store={store} panes={panes} />));

    // First appearance snaps: no tween, ring already on A (inflated by 4px).
    expect(rafCbs.size).toBe(0);
    expect(ringRect()).toEqual({ top: A.top - INFLATE, left: A.left - INFLATE, width: A.width + INFLATE * 2, height: A.height + INFLATE * 2 });

    // Selecting b starts a tween and schedules the loop.
    await act(async () => root.render(<Harness selectedId="b" mode="passthrough" store={store} panes={panes} />));
    expect(rafCbs.size).toBe(1);

    await frame(110); // ~halfway through the 220ms travel
    const mid = ringRect()!;
    // Strictly between A and B on every axis — actually moving, not snapped.
    expect(mid.top).toBeGreaterThan(A.top - INFLATE);
    expect(mid.top).toBeLessThan(B.top - INFLATE);
    expect(mid.left).toBeGreaterThan(A.left - INFLATE);
    expect(mid.left).toBeLessThan(B.left - INFLATE);
    expect(mid.width).toBeGreaterThan(A.width + INFLATE * 2);
    expect(mid.width).toBeLessThan(B.width + INFLATE * 2);

    await frame(200); // now past 220ms total
    expect(ringRect()).toEqual({ top: B.top - INFLATE, left: B.left - INFLATE, width: B.width + INFLATE * 2, height: B.height + INFLATE * 2 });
    // Tween cleared: the loop stops scheduling.
    expect(rafCbs.size).toBe(0);
  });

  it('snaps instantly under reduced motion (no tween, no rAF)', async () => {
    globalThis.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'), media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    })) as unknown as typeof matchMedia;

    const store = makeStore();
    const panes = twoPanes();
    await act(async () => root.render(<Harness selectedId="a" mode="passthrough" store={store} panes={panes} />));
    await act(async () => root.render(<Harness selectedId="b" mode="passthrough" store={store} panes={panes} />));

    // Landed on B immediately, no frame stepping.
    expect(rafCbs.size).toBe(0);
    expect(ringRect()).toEqual({ top: B.top - INFLATE, left: B.left - INFLATE, width: B.width + INFLATE * 2, height: B.height + INFLATE * 2 });
  });

  it('snaps a same-identity geometry change 1:1 (no tween)', async () => {
    const store = makeStore();
    const panes = twoPanes();
    await act(async () => root.render(<Harness selectedId="a" mode="passthrough" store={store} panes={panes} />));

    // The selected pane moves/resizes in place (a sash drag); a store commit
    // re-measures. Same identity + no tween → snap straight to the new geometry.
    const moved: Rectish = { top: 50, left: 80, width: 120, height: 44 };
    stubRect(panes.get('a')!, moved);
    await act(async () => store.commit());

    expect(rafCbs.size).toBe(0);
    expect(ringRect()).toEqual({ top: moved.top - INFLATE, left: moved.left - INFLATE, width: moved.width + INFLATE * 2, height: moved.height + INFLATE * 2 });
  });

  it('clears to null when selection is cleared mid-tween', async () => {
    const store = makeStore();
    const panes = twoPanes();
    await act(async () => root.render(<Harness selectedId="a" mode="passthrough" store={store} panes={panes} />));
    await act(async () => root.render(<Harness selectedId="b" mode="passthrough" store={store} panes={panes} />));
    await frame(110); // mid-tween, a rAF is pending
    expect(rafCbs.size).toBe(1);

    await act(async () => root.render(<Harness selectedId={null} mode="passthrough" store={store} panes={panes} />));
    expect(ring()).toBeNull();
    // The in-flight loop is cancelled.
    expect(rafCbs.size).toBe(0);
  });

  it('cancels the rAF loop on unmount', async () => {
    const store = makeStore();
    const panes = twoPanes();
    await act(async () => root.render(<Harness selectedId="a" mode="passthrough" store={store} panes={panes} />));
    await act(async () => root.render(<Harness selectedId="b" mode="passthrough" store={store} panes={panes} />));
    expect(rafCbs.size).toBe(1);

    await act(async () => root.unmount());
    expect(rafCbs.size).toBe(0);
  });
});

describe('SelectionRing settled render', () => {
  // A resting ring (first-appearance snap → no tween → null velocity) carries no
  // motion smear at all — this is what keeps Chromatic deterministic — and the
  // passthrough ring is a 1px solid stroke, pixel-parity with the retired CSS border.
  it('is a 1px non-dashed stroke with no motion smear', async () => {
    const store = makeStore();
    const panes = twoPanes();
    await act(async () => root.render(<Harness selectedId="a" mode="passthrough" store={store} panes={panes} />));

    expect(rafCbs.size).toBe(0); // settled: no tween running
    const path = container.querySelector('[data-ring="outline"]');
    expect(path).not.toBeNull();
    expect(path!.getAttribute('stroke-width')).toBe('1');
    expect(path!.getAttribute('stroke-dasharray')).toBeNull();
    // A settled ring carries neither smear attribute (deterministic snapshots).
    expect(path!.getAttribute('transform')).toBeNull();
    expect(path!.getAttribute('stroke-opacity')).toBeNull();
  });

  // The path element is shared across variants and the dash is an imperative write
  // React never reconciles away — a command→passthrough flip must clear it, or the
  // 1px solid ring renders the ants' dash as a dotted line.
  it('clears the ants dash when flipping command → passthrough', async () => {
    const store = makeStore();
    const panes = twoPanes();
    await act(async () => root.render(<Harness selectedId="a" mode="command" store={store} panes={panes} />));

    const path = container.querySelector('[data-ring="outline"]');
    expect(path!.getAttribute('stroke-dasharray')).not.toBeNull();

    await act(async () => root.render(<Harness selectedId="a" mode="passthrough" store={store} panes={panes} />));
    expect(path!.getAttribute('stroke-width')).toBe('1');
    expect(path!.getAttribute('stroke-dasharray')).toBeNull();
    expect(path!.style.getPropertyValue('--march-offset')).toBe('');
  });
});

describe('SelectionRing motion smear', () => {
  /** The eight smear pieces, in render order: top, right, bottom, left, then the
   *  four corners. See `SMEAR_PIECES`. */
  function smearPieces() {
    const group = container.querySelector('[data-ring="smear"]') as SVGGElement;
    const at = (i: number) => group.children[i] as SVGPathElement;
    return {
      group,
      top: at(0), right: at(1), bottom: at(2), left: at(3),
      tr: at(4), br: at(5), bl: at(6), tl: at(7),
    };
  }
  const widthOf = (el: SVGPathElement) => Number(el.getAttribute('stroke-width'));
  const opacityOf = (el: SVGPathElement) => Number(el.getAttribute('stroke-opacity'));

  // Two panes flush at the top, differing in height — the layout that motivated
  // the per-edge model. Travelling A→B the top edge translates purely sideways,
  // so it never crosses itself and must not smear at all, while the bottom edge
  // moves diagonally and smears hard. A single ring-center velocity would average
  // those into the same wrong answer for both.
  const FLUSH_A: Rectish = { top: 0, left: 0, width: 100, height: 200 };
  const FLUSH_B: Rectish = { top: 0, left: 300, width: 100, height: 60 };

  function flushPanes(): Map<string, HTMLElement> {
    const elA = document.createElement('div');
    const elB = document.createElement('div');
    stubRect(elA, FLUSH_A);
    stubRect(elB, FLUSH_B);
    document.body.append(elA, elB);
    return new Map([['a', elA], ['b', elB]]);
  }

  it('smears each edge by its own perpendicular motion, not the ring centre', async () => {
    const store = makeStore();
    const panes = flushPanes();
    await act(async () => root.render(<Harness selectedId="a" mode="command" store={store} panes={panes} />));
    expect(smearPieces().group.style.display).toBe('none'); // settled: no smear

    await act(async () => root.render(<Harness selectedId="b" mode="command" store={store} panes={panes} />));
    await frame(16); // seeds the sampler — the first tick has no previous edges
    await frame(16); // now moving

    const p = smearPieces();
    expect(p.group.style.display).toBe('');
    // Tops are flush, so the top edge has zero perpendicular speed: base width,
    // and fully transparent so it lays no band under the crisp ring.
    expect(widthOf(p.top)).toBe(cfg.marchingAnts.strokeWidth);
    expect(opacityOf(p.top)).toBe(0);
    // The bottom edge jumps 140px, so it smears — strictly wider and visible.
    expect(widthOf(p.bottom)).toBeGreaterThan(widthOf(p.top));
    expect(opacityOf(p.bottom)).toBeGreaterThan(0);
    // Both vertical edges translate sideways at the same rate, so they match.
    expect(widthOf(p.left)).toBeCloseTo(widthOf(p.right));
    expect(widthOf(p.left)).toBeGreaterThan(widthOf(p.top));

    await frame(400); // settle
    expect(smearPieces().group.style.display).toBe('none');
  });

  it('tapers each corner between the two edge widths it joins', async () => {
    const store = makeStore();
    const panes = flushPanes();
    await act(async () => root.render(<Harness selectedId="a" mode="command" store={store} panes={panes} />));
    await act(async () => root.render(<Harness selectedId="b" mode="command" store={store} panes={panes} />));
    await frame(16);
    await frame(16);

    const p = smearPieces();
    // A corner is stroked at unit width and scaled, so `scale(a b)` renders the
    // vertical neighbour's width where its tangent is vertical and the horizontal
    // neighbour's where it is horizontal — no seam at either join.
    expect(widthOf(p.tr)).toBe(1);
    expect(p.tr.getAttribute('transform'))
      .toBe(`scale(${widthOf(p.right)} ${widthOf(p.top)})`);
    expect(p.bl.getAttribute('transform'))
      .toBe(`scale(${widthOf(p.left)} ${widthOf(p.bottom)})`);
  });

  // The ring itself is never transformed or re-dashed: keeping it one unbroken
  // path is what makes the marching-ants phase continuous around the perimeter,
  // and the smear lives in a sibling layer precisely so this stays true.
  it('leaves the ants ring crisp and unbroken while smearing', async () => {
    const store = makeStore();
    const panes = flushPanes();
    await act(async () => root.render(<Harness selectedId="a" mode="command" store={store} panes={panes} />));

    const path = container.querySelector('[data-ring="outline"]')!;
    expect(path.getAttribute('stroke-dasharray')).toBe('6 4');
    expect(path.style.getPropertyValue('--march-offset')).toBe('-10px');

    await act(async () => root.render(<Harness selectedId="b" mode="command" store={store} panes={panes} />));
    await frame(16);
    await frame(16);

    expect(path.getAttribute('stroke-dasharray')).toBe('6 4');
    expect(path.style.getPropertyValue('--march-offset')).toBe('-10px');
    expect(path.getAttribute('transform')).toBeNull();
    expect(path.getAttribute('stroke-opacity')).toBeNull();
  });
});
