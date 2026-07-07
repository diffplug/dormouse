/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LathHost } from './LathHost';
import { createLathWallStore, type LathWallStore, type LeafMeta, LATH_LAYOUT_OPTS } from './lath-wall-store';
import { createLathWallEngine } from './lath-wall-engine';
import { layout } from '../../lib/lath/layout';
import { LATH_EASING } from '../../lib/lath/animator';
import { type DropTarget, move } from '../../lib/lath/ops';
import { leafTree, type LathNode, type LathTree, type Rect } from '../../lib/lath/model';
import { leaf, split, tree as treeOf, movePreview as movePreviewAt } from '../../lib/lath/test-util';
import { leafMeta } from '../../lib/lath/test-fixtures';
import type { PaneProps } from './pane-props';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const W = 800;
const H = 600;
const RECT = { x: 0, y: 0, width: W, height: H };

/** Expected preview rect of an internal drag under this suite's rect + opts. */
const movePreview = (t: LathTree, dragged: string, target: DropTarget): Rect =>
  movePreviewAt(t, dragged, target, RECT, LATH_LAYOUT_OPTS);

// The hit-test / sash-preview recompute is coalesced into one requestAnimationFrame;
// wait a real frame so the pending commit lands before asserting on it.
async function flushFrame() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}


/** a | b | c — an equal-weight row split, built from the shared core test builders. */
const rowOf = (...ids: string[]): LathTree =>
  treeOf(split('row', ...ids.map((id): [LathNode, number] => [leaf(id), 1 / ids.length])));

// --- stub pane components (never mount the real TerminalPane/xterm) ---

let bodyProps: Record<string, PaneProps>;
let tabProps: Record<string, PaneProps>;

function StubBody(props: PaneProps) {
  bodyProps[props.id] = props;
  return <div data-body={props.id} />;
}
function StubTab(props: PaneProps) {
  tabProps[props.id] = props;
  // Include a button so the drag tests can assert a header button never starts a drag.
  return (
    <div data-tab={props.id}>
      <button data-stub-btn={props.id} type="button">
        x
      </button>
    </div>
  );
}
const OVERRIDE = { bodies: { terminal: StubBody }, tabs: { terminal: StubTab } };

let container: HTMLDivElement;
let root: Root;
let rectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  bodyProps = {};
  tabProps = {};
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom has no layout; report a fixed container size for measurement.
  rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, width: W, height: H, top: 0, left: 0, right: W, bottom: H, toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  rectSpy.mockRestore();
});

// Wrap the store in an engine (LathHost drives the whole engine now). Default to a
// 0 duration so the geometry/structure tests see frames applied instantly; animation
// tests pass a fixed duration and a fake clock.
function mount(store: LathWallStore, onCommitResize = vi.fn(), onLeafFocused = vi.fn(), durationMs = 0) {
  const engine = createLathWallEngine(store, { durationMs });
  act(() => {
    root.render(
      <LathHost lath={engine} onCommitResize={onCommitResize} onLeafFocused={onLeafFocused} componentsOverride={OVERRIDE} />,
    );
  });
  return { engine, onCommitResize, onLeafFocused };
}

function leafDiv(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-lath-leaf="${id}"]`);
}
function leafOrder(): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-lath-leaf]')].map((el) => el.dataset.lathLeaf!);
}

function seeded(tree: LathTree, entries: Array<[string, LeafMeta]>): LathWallStore {
  const store = createLathWallStore();
  store.seed(tree, entries);
  return store;
}

describe('LathHost — node identity (the no-re-parent guarantee)', () => {
  it('keeps surviving leaf divs as the SAME element across split/remove/resize/swap', () => {
    const store = seeded(rowOf('a', 'b', 'c'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })], ['c', leafMeta({ title: 'C' })]]);
    mount(store);

    const a0 = leafDiv('a');
    const b0 = leafDiv('b');
    const c0 = leafDiv('c');
    expect(a0 && b0 && c0).toBeTruthy();

    act(() => store.addLeaf('d', leafMeta({ title: 'D' }), { refId: 'a', edge: 'right' }));
    expect(leafDiv('a')).toBe(a0);
    expect(leafDiv('b')).toBe(b0);
    expect(leafDiv('c')).toBe(c0);
    expect(leafDiv('d')).toBeTruthy(); // new

    act(() => store.removeLeaf('c'));
    expect(leafDiv('c')).toBeNull(); // removed → unmounted
    expect(leafDiv('a')).toBe(a0);
    expect(leafDiv('b')).toBe(b0);
    expect(leafDiv('d')).toBeTruthy();

    // Resize uses the geometry LathHost reported on mount.
    act(() => store.resizeBoundary([], 0, 50));
    expect(leafDiv('a')).toBe(a0);
    expect(leafDiv('b')).toBe(b0);

    // Swap exchanges positions but leaf divs (keyed by id) keep identity.
    act(() => store.swapLeaves('a', 'b'));
    expect(leafDiv('a')).toBe(a0);
    expect(leafDiv('b')).toBe(b0);
  });
});

describe('LathHost — stable DOM order', () => {
  it('renders divs sorted by id even when tree order differs, and stays fixed across a swap', () => {
    // Tree pre-order is c, a, b; DOM order must be the sorted a, b, c.
    const store = seeded(rowOf('c', 'a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })], ['c', leafMeta({ title: 'C' })]]);
    mount(store);
    expect(leafOrder()).toEqual(['a', 'b', 'c']);

    act(() => store.swapLeaves('a', 'c')); // changes layout order, not id set
    expect(leafOrder()).toEqual(['a', 'b', 'c']);
  });
});

describe('LathHost — frames applied to style', () => {
  it('lands each leaf rect from layout() in inline px that tiles the container', () => {
    const tree = rowOf('a', 'b', 'c');
    const store = seeded(tree, [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })], ['c', leafMeta({ title: 'C' })]]);
    mount(store);

    const frames = layout(tree, RECT, LATH_LAYOUT_OPTS);
    for (const id of ['a', 'b', 'c']) {
      const el = leafDiv(id)!;
      const f = frames.get(id)!;
      expect(el.style.left).toBe(`${f.x}px`);
      expect(el.style.top).toBe(`${f.y}px`);
      expect(el.style.width).toBe(`${f.width}px`);
      expect(el.style.height).toBe(`${f.height}px`);
    }
    // Exact tiling: widths + 2 gaps span the full container width.
    const widths = ['a', 'b', 'c'].map((id) => frames.get(id)!.width);
    expect(widths.reduce((a, b) => a + b, 0) + 2 * LATH_LAYOUT_OPTS.gap).toBe(W);
  });
});

describe('LathHost — sash drag', () => {
  function firstSash(): HTMLElement {
    return container.querySelector<HTMLElement>('[data-lath-sash]')!;
  }

  it('previews the resize during the drag and commits once on pointerup', async () => {
    const store = seeded(rowOf('a', 'b', 'c'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })], ['c', leafMeta({ title: 'C' })]]);
    const { onCommitResize } = mount(store);

    const widthBefore = leafDiv('a')!.style.width;
    const sash = firstSash();

    act(() => sash.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 10 })));
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 140, clientY: 10 })));
    await flushFrame();
    // Preview: 'a' (left of boundary 0) grew.
    expect(parseFloat(leafDiv('a')!.style.width)).toBeGreaterThan(parseFloat(widthBefore));
    expect(onCommitResize).not.toHaveBeenCalled();

    act(() => window.dispatchEvent(new MouseEvent('pointerup', {})));
    expect(onCommitResize).toHaveBeenCalledTimes(1);
    expect(onCommitResize).toHaveBeenCalledWith([], 0, 40);
    // The store commits nothing here (that's the Wall's job) → preview reverts.
    expect(leafDiv('a')!.style.width).toBe(widthBefore);
  });

  it('cancels the drag on Escape without committing', () => {
    const store = seeded(rowOf('a', 'b', 'c'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })], ['c', leafMeta({ title: 'C' })]]);
    const { onCommitResize } = mount(store);
    const widthBefore = leafDiv('a')!.style.width;
    const sash = firstSash();

    act(() => sash.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 10 })));
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 130, clientY: 10 })));
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

    expect(onCommitResize).not.toHaveBeenCalled();
    expect(leafDiv('a')!.style.width).toBe(widthBefore); // reverted
  });
});

describe('LathHost — zoom', () => {
  it('renders the zoomed leaf full-rect on top, and restores after', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    mount(store);

    act(() => store.setZoomed('a'));
    const a = leafDiv('a')!;
    expect(a.style.left).toBe('0px');
    expect(a.style.top).toBe('0px');
    expect(a.style.width).toBe(`${W}px`);
    expect(a.style.height).toBe(`${H}px`);
    expect(a.style.zIndex).toBe('40');
    // 'b' keeps its tiled rect beneath.
    expect(leafDiv('b')!.style.zIndex).toBe('0');

    act(() => store.setZoomed(null));
    const frames = layout(rowOf('a', 'b'), RECT, LATH_LAYOUT_OPTS);
    expect(leafDiv('a')!.style.width).toBe(`${frames.get('a')!.width}px`);
  });
});

describe('LathHost — pane props contract', () => {
  it('supplies each body and tab { id, title, params }', () => {
    const store = seeded(rowOf('a', 'b'), [
      ['a', leafMeta({ title: 'A' })],
      ['b', leafMeta({ title: 'B', params: { url: 'x' } })],
    ]);
    mount(store);

    expect(bodyProps['a']).toMatchObject({ id: 'a', title: 'A', params: undefined });
    expect(bodyProps['b']).toMatchObject({ id: 'b', title: 'B', params: { url: 'x' } });
    expect(tabProps['a']).toMatchObject({ id: 'a', title: 'A' });
  });

  it('does not re-render leaf content on a geometry-only frame', () => {
    // A resize commit changes the tree geometry but no leaf's meta, so the memoized
    // LathLeafContent (header + body) must not re-render — only the positioned wrapper.
    const bodyRenders: Record<string, number> = {};
    const tabRenders: Record<string, number> = {};
    const CountingBody = (props: PaneProps) => {
      bodyRenders[props.id] = (bodyRenders[props.id] ?? 0) + 1;
      return <div data-body={props.id} />;
    };
    const CountingTab = (props: PaneProps) => {
      tabRenders[props.id] = (tabRenders[props.id] ?? 0) + 1;
      return <div data-tab={props.id} />;
    };
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    const engine = createLathWallEngine(store, { durationMs: 0 });
    act(() => {
      root.render(
        <LathHost
          lath={engine}
          onCommitResize={vi.fn()}
          onLeafFocused={vi.fn()}
          componentsOverride={{ bodies: { terminal: CountingBody }, tabs: { terminal: CountingTab } }}
        />,
      );
    });
    const before = { ba: bodyRenders['a'], bb: bodyRenders['b'], ta: tabRenders['a'], tb: tabRenders['b'] };

    act(() => store.resizeBoundary([], 0, 40)); // geometry-only: weights change, meta does not

    expect(bodyRenders['a']).toBe(before.ba);
    expect(bodyRenders['b']).toBe(before.bb);
    expect(tabRenders['a']).toBe(before.ta);
    expect(tabRenders['b']).toBe(before.tb);
  });

  it('reports focusin inside a leaf via onLeafFocused', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    const { onLeafFocused } = mount(store);
    act(() => leafDiv('a')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    expect(onLeafFocused).toHaveBeenCalledWith('a');
  });
});

describe('LathHost — empty tree', () => {
  it('renders nothing and does not crash', () => {
    const store = createLathWallStore();
    expect(() => mount(store)).not.toThrow();
    expect(leafOrder()).toEqual([]);
    expect(container.querySelector('[data-lath-sash]')).toBeNull();
  });
});

describe('LathHost — imperative animation frames', () => {
  const DUR = 400;
  let clock: number;
  let rafCbs: FrameRequestCallback[];
  let spies: Array<{ mockRestore: () => void }>;

  beforeEach(() => {
    clock = 1000;
    rafCbs = [];
    spies = [
      vi.spyOn(performance, 'now').mockImplementation(() => clock),
      vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
        rafCbs.push(cb);
        return rafCbs.length;
      }),
      vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {}),
    ];
  });
  afterEach(() => {
    for (const s of spies) s.mockRestore();
  });

  // Run every queued animation frame at the current clock (the loop reschedules
  // itself, so callers advance the clock and flush again per step).
  function flushRaf(): void {
    const cbs = rafCbs.splice(0);
    act(() => {
      for (const cb of cbs) cb(clock);
    });
  }
  const widthOf = (id: string): number => parseFloat(leafDiv(id)!.style.width);

  it('tweens a survivor from its old rect to its new rect, then stops ticking', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    mount(store, vi.fn(), vi.fn(), DUR);

    const twoWide = widthOf('a'); // 'a' at 50% of the row
    // Split 'c' beside 'a' → 'a' must shrink to ~1/3. No enter hint for 'c', so it
    // appears instantly; 'a' and 'b' tween.
    act(() => store.addLeaf('c', leafMeta({ title: 'C' }), { refId: 'a', edge: 'right' }));
    const threeWide = layout(store.getSnapshot().tree, RECT, LATH_LAYOUT_OPTS).get('a')!.width;

    // t = 0: still at the old width (retarget starts from the current frame).
    expect(widthOf('a')).toBeCloseTo(twoWide, 1);
    expect(rafCbs.length).toBeGreaterThan(0); // loop scheduled

    // t = 0.5: interpolated through the house easing.
    clock += DUR / 2;
    flushRaf();
    const expectedMid = twoWide + (threeWide - twoWide) * LATH_EASING(0.5);
    expect(widthOf('a')).toBeCloseTo(expectedMid, 0);

    // t = 1: settled at the target, and the loop stops (no reschedule).
    clock += DUR / 2;
    flushRaf();
    expect(widthOf('a')).toBeCloseTo(threeWide, 1);
    expect(rafCbs.length).toBe(0);
  });

  it('a meta re-render mid-tween does not snap the leaf to its target', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    mount(store, vi.fn(), vi.fn(), DUR);

    act(() => store.addLeaf('c', leafMeta({ title: 'C' }), { refId: 'a', edge: 'right' }));
    clock += DUR / 2;
    flushRaf();
    const midWidth = widthOf('a');
    const target = layout(store.getSnapshot().tree, RECT, LATH_LAYOUT_OPTS).get('a')!.width;
    expect(midWidth).not.toBeCloseTo(target, 0); // genuinely mid-flight

    // A pure meta write re-renders the leaf but must not snap its inline geometry.
    act(() => store.setTitle('a', 'Renamed'));
    expect(widthOf('a')).toBeCloseTo(midWidth, 1);
  });

  it('fades a dying leaf in place with pointer-events off, above the survivors', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    const { engine } = mount(store, vi.fn(), vi.fn(), DUR);

    act(() => engine.markDying('b'));
    const b = leafDiv('b')!;
    expect(b.style.pointerEvents).toBe('none');
    expect(b.style.zIndex).toBe('35'); // Z_DYING — above tiled survivors
    expect(engine.isDying('b')).toBe(true);

    clock += DUR / 2;
    flushRaf();
    const mid = parseFloat(b.style.opacity);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);

    clock += DUR / 2;
    flushRaf();
    expect(b.style.opacity).toBe('0');
    expect(rafCbs.length).toBe(0); // settled → loop stops
  });

  it('shrinks the last pane toward its bottom-right corner as it dies', () => {
    const store = seeded(leafTree('solo'), [['solo', leafMeta({ title: 'Solo' })]]);
    const { engine } = mount(store, vi.fn(), vi.fn(), DUR);
    expect(widthOf('solo')).toBeCloseTo(W, 0); // full-rect single pane

    act(() => engine.markDying('solo', { shrinkTowardBottomRight: true }));
    clock += DUR;
    flushRaf();
    const el = leafDiv('solo')!;
    expect(parseFloat(el.style.width)).toBeCloseTo(0, 1);
    expect(parseFloat(el.style.height)).toBeCloseTo(0, 1);
    expect(parseFloat(el.style.left)).toBeCloseTo(W, 0); // collapsed to the bottom-right
    expect(parseFloat(el.style.top)).toBeCloseTo(H, 0);
    expect(el.style.opacity).toBe('0');
  });

  it('snaps (no tween) on a sash-drag commit — the user placed the boundary by hand', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    // onCommitResize commits the resize (as the Wall does), so the tree changes.
    mount(store, (sp, b, d) => { store.resizeBoundary(sp, b, d); }, vi.fn(), DUR);

    const before = widthOf('a');
    const sash = container.querySelector<HTMLElement>('[data-lath-sash]')!;
    act(() => sash.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 10 })));
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 160, clientY: 10 })));
    act(() => window.dispatchEvent(new MouseEvent('pointerup', {})));

    // Commit landed immediately at the resized width (snap), not tweening from `before`.
    const after = widthOf('a');
    expect(after).toBeGreaterThan(before);
    // Advancing the clock changes nothing — there is no tween in flight.
    clock += DUR;
    expect(widthOf('a')).toBeCloseTo(after, 1);
  });
});

describe('LathHost — pane / Door drag', () => {
  type DragHandlers = {
    onDragStart: ReturnType<typeof vi.fn>;
    onProposeMove: ReturnType<typeof vi.fn>;
    onProposeMinimize: ReturnType<typeof vi.fn>;
    onExternalDrop: ReturnType<typeof vi.fn>;
  };

  function mountDrag(
    store: LathWallStore,
    props: { externalDrag?: { id: string; startX: number; startY: number } | null } = {},
  ): { engine: ReturnType<typeof createLathWallEngine> } & DragHandlers {
    const engine = createLathWallEngine(store, { durationMs: 0 });
    const handlers: DragHandlers = {
      onDragStart: vi.fn(),
      onProposeMove: vi.fn(),
      onProposeMinimize: vi.fn(),
      onExternalDrop: vi.fn(),
    };
    act(() => {
      root.render(
        <LathHost
          lath={engine}
          onCommitResize={vi.fn()}
          componentsOverride={OVERRIDE}
          externalDrag={props.externalDrag ?? null}
          {...handlers}
        />,
      );
    });
    return { engine, ...handlers };
  }

  function header(id: string): HTMLElement {
    return leafDiv(id)!.querySelector<HTMLElement>('.lath-leaf-header')!;
  }
  function overlayEl(): HTMLElement | null {
    return container.querySelector<HTMLElement>('[data-lath-drop-preview]');
  }
  function overlayRect(): Rect {
    const el = overlayEl()!;
    return {
      x: parseFloat(el.style.left),
      y: parseFloat(el.style.top),
      width: parseFloat(el.style.width),
      height: parseFloat(el.style.height),
    };
  }
  const down = (el: HTMLElement, x: number, y: number) =>
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
  const moveTo = (x: number, y: number) => window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y }));
  const up = () => window.dispatchEvent(new MouseEvent('pointerup', {}));

  // col[ row[a, b], c ]: dragging c onto a's top edge yields two distinct candidates —
  // above 'a' (leaf level) and above the whole a|b row (its ancestor).
  function colRowTree(): LathTree {
    return { root: split('col', [split('row', [leaf('a'), 0.5], [leaf('b'), 0.5]), 0.5], [leaf('c'), 0.5]) };
  }

  it('enters a drag past the threshold and calls onDragStart, dimming the leaf', () => {
    const store = seeded(rowOf('a', 'b', 'c'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })], ['c', leafMeta({ title: 'C' })]]);
    const { onDragStart } = mountDrag(store);

    act(() => down(header('a'), 100, 15));
    act(() => moveTo(102, 15)); // < 5px — not yet a drag
    expect(onDragStart).not.toHaveBeenCalled();

    act(() => moveTo(120, 15)); // past the threshold
    expect(onDragStart).toHaveBeenCalledWith('a');
    expect(leafDiv('a')!.style.opacity).toBe('0.6');

    act(() => up());
    expect(leafDiv('a')!.style.opacity).toBe('');
  });

  it('shows the innermost candidate preview and commits it on pointerup', async () => {
    const t = rowOf('a', 'b');
    const store = seeded(t, [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    const { onProposeMove } = mountDrag(store);

    act(() => down(header('a'), 100, 15));
    act(() => moveTo(601, 300)); // b's center → swap
    await flushFrame();
    expect(overlayEl()).not.toBeNull();
    expect(overlayRect()).toEqual(movePreview(t, 'a', { kind: 'swap', leaf: 'b' }));

    act(() => up());
    expect(onProposeMove).toHaveBeenCalledWith('a', { kind: 'swap', leaf: 'b' });
    expect(overlayEl()).toBeNull(); // preview cleared on drop
  });

  it('cycles the drop depth outward with the wheel', async () => {
    const t = colRowTree();
    const store = seeded(t, [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })], ['c', leafMeta({ title: 'C' })]]);
    const { onProposeMove } = mountDrag(store);

    // Drag c onto a's top edge (a spans y 0..~297, x 0..~397).
    act(() => down(header('c'), 100, 320)); // press on c's header (c is the bottom leaf)
    act(() => moveTo(100, 5)); // a's top band
    await flushFrame();
    expect(overlayRect()).toEqual(movePreview(t, 'c', { kind: 'edge', path: [0, 0], edge: 'top' }));

    act(() => window.dispatchEvent(new WheelEvent('wheel', { deltaY: 10, cancelable: true })));
    expect(overlayRect()).toEqual(movePreview(t, 'c', { kind: 'edge', path: [0], edge: 'top' }));

    act(() => up());
    expect(onProposeMove).toHaveBeenCalledWith('c', { kind: 'edge', path: [0], edge: 'top' });
  });

  it('proposes a minimize when dropped below the wall (baseboard zone)', async () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    const { onProposeMinimize, onProposeMove } = mountDrag(store);

    act(() => down(header('a'), 100, 15));
    act(() => moveTo(100, 650)); // below the 600px container → baseboard zone
    await flushFrame();
    expect(overlayEl()).toBeNull(); // no drop preview in the baseboard zone

    act(() => up());
    expect(onProposeMinimize).toHaveBeenCalledWith('a');
    expect(onProposeMove).not.toHaveBeenCalled();
  });

  it('cancels on Escape with no proposal', async () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    const { onProposeMove, onProposeMinimize } = mountDrag(store);

    act(() => down(header('a'), 100, 15));
    act(() => moveTo(601, 300));
    await flushFrame();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

    expect(onProposeMove).not.toHaveBeenCalled();
    expect(onProposeMinimize).not.toHaveBeenCalled();
    expect(overlayEl()).toBeNull();
  });

  it('does not drag on a sub-threshold press (click preserved)', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    const { onDragStart, onProposeMove } = mountDrag(store);

    act(() => down(header('a'), 100, 15));
    act(() => moveTo(102, 16));
    act(() => up());
    expect(onDragStart).not.toHaveBeenCalled();
    expect(onProposeMove).not.toHaveBeenCalled();
  });

  it('does not start a drag from a header button', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    const { onDragStart } = mountDrag(store);

    const btn = leafDiv('a')!.querySelector<HTMLElement>('[data-stub-btn="a"]')!;
    act(() => down(btn, 100, 15));
    act(() => moveTo(140, 15));
    expect(onDragStart).not.toHaveBeenCalled();
  });

  it('runs external (Door) drags with dragged null and fires onExternalDrop', async () => {
    const t = rowOf('a', 'b');
    const store = seeded(t, [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    // 'door' is not a leaf — the chip stays in the baseboard; LathHost only hit-tests.
    // The external drag starts INACTIVE at the press point; the move past the threshold
    // activates it (like an internal drag).
    const { onExternalDrop } = mountDrag(store, { externalDrag: { id: 'door', startX: 100, startY: 300 } });

    act(() => moveTo(410, 300)); // past the threshold → b's left edge
    await flushFrame();
    expect(overlayEl()).not.toBeNull(); // previewed via insert (dragged null → no swap)

    act(() => up());
    expect(onExternalDrop).toHaveBeenCalledWith({ kind: 'edge', path: [1], edge: 'left' });
  });

  it('a sub-threshold Door press-release reports null (drag cleared; the click stands)', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    // A press that never crosses the threshold: the external drag stays inactive.
    const { onExternalDrop } = mountDrag(store, { externalDrag: { id: 'door', startX: 100, startY: 300 } });

    act(() => moveTo(102, 301)); // < 5px — not a drag
    act(() => up());
    // Reported so the Wall drops its transient door-drag state; a `null` target means
    // "no drop" so the Door's own click-reattach is what actually restores it.
    expect(onExternalDrop).toHaveBeenCalledWith(null);
    expect(overlayEl()).toBeNull();
  });

  it('hit-tests the LIVE tree when a background commit lands mid-drag', async () => {
    const store = seeded(rowOf('a', 'b', 'c'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })], ['c', leafMeta({ title: 'C' })]]);
    const { onProposeMove } = mountDrag(store);

    // Start dragging 'a', hovering over the far-right third (c's slot in the 3-leaf tree).
    act(() => down(header('a'), 100, 15));
    act(() => moveTo(700, 300));
    await flushFrame();
    expect(overlayEl()).not.toBeNull();

    // A background `dor kill` removes 'b' mid-drag → the store commits a NEW 2-leaf tree.
    act(() => store.removeLeaf('b'));
    const liveTree = store.getSnapshot().tree;

    // The next frame hit-tests the live tree: 700,300 now sits in c's (widened) center.
    act(() => moveTo(700, 300));
    await flushFrame();
    const target: DropTarget = { kind: 'swap', leaf: 'c' };
    expect(move(liveTree, 'a', target).ok).toBe(true); // the target is valid on the live tree
    expect(overlayRect()).toEqual(movePreview(liveTree, 'a', target));

    act(() => up());
    expect(onProposeMove).toHaveBeenCalledWith('a', target);
  });
});
