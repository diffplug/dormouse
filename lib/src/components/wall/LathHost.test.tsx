/**
 * @vitest-environment jsdom
 */
import { act, StrictMode, useContext } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LathHost, LATH_ZOOM_MARGIN, LATH_ZOOM_SHADOW } from './LathHost';
import { createLathWallStore, type LathWallStore, type LeafMeta, LATH_LAYOUT_OPTS } from './lath-wall-store';
import { type ContextHelper, createLathWallEngine } from './lath-wall-engine';
import { layout } from '../../lib/lath/layout';
import { LATH_EASING } from '../../lib/lath/animator';
import { type DropTarget, move } from '../../lib/lath/ops';
import { leafTree, type LathNode, type LathTree, type Rect } from '../../lib/lath/model';
import { leaf, split, tree as treeOf, movePreview as movePreviewAt } from '../../lib/lath/test-util';
import { leafMeta } from '../../lib/lath/test-fixtures';
import { PANE_HEADER_HEIGHT_PX } from '../design';
import { SLIDE_ARM_MS } from './lath-drag-controller';
import type { PaneProps } from './pane-props';
import { LayoutFramesContext } from './wall-context';

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

describe('LathHost — parked leaves', () => {
  it('retains the same document after more than eight browsers are minimized', () => {
    const meta = leafMeta({ component: 'terminal' });
    const store = seeded(rowOf('a', 'b'), [['a', meta], ['b', meta]]);
    mount(store);
    const original = leafDiv('b')!;
    const input = document.createElement('input');
    input.value = 'unsaved draft';
    original.appendChild(input);
    let token: ReturnType<LathWallStore['doorLeaf']>['token'];
    act(() => { token = store.doorLeaf('b', { park: true }).token; });
    for (let i = 0; i < 32; i++) {
      act(() => store.addLeaf(`browser-${i}`, meta, { refId: 'a', edge: 'right' }));
      act(() => { store.doorLeaf(`browser-${i}`, { park: true }); });
    }
    expect(leafDiv('b')).toBe(original);
    expect(input.isConnected).toBe(true);
    act(() => { store.restoreLeaf(meta, token!); });
    expect(leafDiv('b')).toBe(original);
    expect(input.value).toBe('unsaved draft');
    expect(input.isConnected).toBe(true);
  });

  it('keeps a parked leaf as the SAME element, holding its last rect but painting nothing', () => {
    const tree = rowOf('a', 'b');
    const store = seeded(tree, [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    mount(store);

    const b0 = leafDiv('b')!;
    const rect = layout(tree, RECT, LATH_LAYOUT_OPTS).get('b')!;
    const bodyEl = b0.querySelector('[data-body="b"]');
    expect(bodyEl).toBeTruthy();

    act(() => store.doorLeaf('b', { park: true }));

    // The whole point: the div — and everything inside it, an <iframe>'s document
    // included — is the same node, never unmounted and never re-parented.
    expect(leafDiv('b')).toBe(b0);
    expect(b0.querySelector('[data-body="b"]')).toBe(bodyEl);
    expect(b0.dataset.lathParked).toBe('');
    expect(b0.style.visibility).toBe('hidden');
    expect(b0.style.pointerEvents).toBe('none');
    // It holds the rect it had, so the guest never sees a 0x0 viewport.
    expect(b0.style.width).toBe(`${rect.width}px`);
    expect(b0.style.height).toBe(`${rect.height}px`);
    // The survivor reclaims the whole wall.
    expect(leafDiv('a')!.style.width).toBe(`${W}px`);
  });

  it('tells the parked body it is parked, and clears it on restore', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    mount(store);
    expect(bodyProps.b.parked).toBe(false);

    let token: ReturnType<LathWallStore['doorLeaf']>['token'] = null;
    act(() => { token = store.doorLeaf('b', { park: true }).token; });
    expect(bodyProps.b.parked).toBe(true);

    act(() => { store.restoreLeaf(leafMeta({ title: 'B' }), token!, { fallbackRef: 'a' }); });
    expect(bodyProps.b.parked).toBe(false);
  });

  it('keeps a parked leaf rendering its live meta, and unpark returns it to the tiling', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    mount(store);
    const b0 = leafDiv('b')!;

    let token: ReturnType<LathWallStore['doorLeaf']>['token'] = null;
    act(() => { token = store.doorLeaf('b', { park: true }).token; });
    // A parked Surface keeps running, so its meta keeps flowing to the mounted body.
    act(() => store.setTitle('b', 'navigated'));
    expect(bodyProps.b.title).toBe('navigated');

    act(() => { store.restoreLeaf(leafMeta({ title: 'navigated' }), token!, { fallbackRef: 'a' }); });
    expect(leafDiv('b')).toBe(b0);
    expect(b0.dataset.lathParked).toBeUndefined();
    expect(b0.style.visibility).toBe('');
    expect(b0.style.pointerEvents).toBe('');
    expect(b0.style.width).toBe(`${layout(rowOf('a', 'b'), RECT, LATH_LAYOUT_OPTS).get('b')!.width}px`);
  });

  it('holds its rect under StrictMode, where React detaches and re-attaches every ref', () => {
    // Regression: `registerEl(null)` used to prune the remembered-rect map. A ref
    // DETACH is not an unmount — React also detaches when the callback identity
    // changes, which StrictMode does on every commit — so parking then fell back to
    // the whole-wall rect and resized the guest document. Caught live, not here.
    const tree = rowOf('a', 'b');
    const store = seeded(tree, [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    const engine = createLathWallEngine(store, { durationMs: 0 });
    act(() => {
      root.render(
        <StrictMode>
          <LathHost lath={engine} onCommitResize={vi.fn()} onLeafFocused={vi.fn()} componentsOverride={OVERRIDE} />
        </StrictMode>,
      );
    });

    const rect = layout(tree, RECT, LATH_LAYOUT_OPTS).get('b')!;
    act(() => { store.doorLeaf('b', { park: true }); });
    const el = leafDiv('b')!;
    expect(el.dataset.lathParked).toBe('');
    expect(el.style.width).toBe(`${rect.width}px`);
    expect(el.style.left).toBe(`${rect.x}px`);
  });

  it('forgetLeaf without a restore unmounts the leaf for real', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    mount(store);
    act(() => { store.doorLeaf('b', { park: true }); });
    expect(leafDiv('b')).toBeTruthy();
    act(() => store.forgetLeaf('b'));
    expect(leafDiv('b')).toBeNull();
  });

  it('keeps parked leaves in the sorted DOM order rather than moving siblings', () => {
    const store = seeded(rowOf('a', 'b', 'c'), [['a', leafMeta()], ['b', leafMeta()], ['c', leafMeta()]]);
    mount(store);
    expect(leafOrder()).toEqual(['a', 'b', 'c']);
    act(() => { store.doorLeaf('b', { park: true }); });
    expect(leafOrder()).toEqual(['a', 'b', 'c']);
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

    act(() => window.dispatchEvent(new MouseEvent('pointerup', { clientX: 140, clientY: 10 })));
    expect(onCommitResize).toHaveBeenCalledTimes(1);
    expect(onCommitResize).toHaveBeenCalledWith([], 0, 40);
    // The store commits nothing here (that's the Wall's job) → preview reverts.
    expect(leafDiv('a')!.style.width).toBe(widthBefore);
  });

  it('uses the release coordinates even when no final pointermove arrives', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta()], ['b', leafMeta()]]);
    const { onCommitResize } = mount(store);
    act(() => firstSash().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 10 })));
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 120, clientY: 10 })));
    act(() => window.dispatchEvent(new MouseEvent('pointerup', { clientX: 145, clientY: 10 })));
    expect(onCommitResize).toHaveBeenCalledWith([], 0, 45);
  });

  it('cancels on pointercancel and accepts the next sash gesture', async () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta()], ['b', leafMeta()]]);
    const { onCommitResize } = mount(store);
    const widthBefore = leafDiv('a')!.style.width;
    act(() => firstSash().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100 })));
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 140 })));
    await flushFrame();
    act(() => window.dispatchEvent(new MouseEvent('pointercancel')));
    expect(leafDiv('a')!.style.width).toBe(widthBefore);
    act(() => window.dispatchEvent(new MouseEvent('pointerup', { clientX: 140 })));
    expect(onCommitResize).not.toHaveBeenCalled();
    act(() => firstSash().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100 })));
    act(() => window.dispatchEvent(new MouseEvent('pointerup', { clientX: 125 })));
    expect(onCommitResize).toHaveBeenCalledExactlyOnceWith([], 0, 25);
  });

  it('abandons an obsolete sash path after a concurrent tree mutation', async () => {
    const store = seeded(rowOf('a', 'b', 'c'), [['a', leafMeta()], ['b', leafMeta()], ['c', leafMeta()]]);
    const { onCommitResize } = mount(store);
    act(() => firstSash().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100 })));
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 140 })));
    await flushFrame();
    act(() => store.removeLeaf('a'));
    expect(leafDiv('a')).toBeNull();
    act(() => window.dispatchEvent(new MouseEvent('pointerup', { clientX: 140 })));
    expect(onCommitResize).not.toHaveBeenCalled();
  });

  it('ignores a sash press from a render superseded by a synchronous tree commit', () => {
    const store = seeded(rowOf('a', 'b', 'c'), [['a', leafMeta()], ['b', leafMeta()], ['c', leafMeta()]]);
    const { onCommitResize } = mount(store);
    const staleSash = firstSash();
    act(() => {
      store.removeLeaf('a');
      staleSash.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100 }));
    });
    act(() => window.dispatchEvent(new MouseEvent('pointerup', { clientX: 140 })));
    expect(onCommitResize).not.toHaveBeenCalled();
  });

  it('keeps a sash gesture alive across metadata updates', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta()], ['b', leafMeta()]]);
    const { onCommitResize } = mount(store);
    act(() => firstSash().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100 })));
    act(() => store.setTitle('a', 'New title'));
    act(() => window.dispatchEvent(new MouseEvent('pointerup', { clientX: 140 })));
    expect(onCommitResize).toHaveBeenCalledExactlyOnceWith([], 0, 40);
  });

  it('ignores secondary-button sash presses', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta()], ['b', leafMeta()]]);
    const { onCommitResize } = mount(store);
    act(() => firstSash().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 2, clientX: 100 })));
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 140 })));
    act(() => window.dispatchEvent(new MouseEvent('pointerup', { button: 2, clientX: 140 })));
    expect(onCommitResize).not.toHaveBeenCalled();
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
  it('insets elevated zoom by half the pane-header height', () => {
    const store = seeded(leafTree('a'), [['a', leafMeta({ title: 'A' })]]);
    mount(store);

    const header = container.querySelector<HTMLElement>('.lath-leaf-header')!;
    expect(header.style.height).toBe(`${PANE_HEADER_HEIGHT_PX}px`);
    expect(LATH_ZOOM_MARGIN).toBe(PANE_HEADER_HEIGHT_PX / 2);
  });

  it('renders the zoomed leaf inset above the tiled layout, and restores after', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    mount(store);

    act(() => store.setZoomed('a'));
    const a = leafDiv('a')!;
    expect(a.style.left).toBe(`${LATH_ZOOM_MARGIN}px`);
    expect(a.style.top).toBe(`${LATH_ZOOM_MARGIN}px`);
    expect(a.style.width).toBe(`${W - LATH_ZOOM_MARGIN * 2}px`);
    expect(a.style.height).toBe(`${H - LATH_ZOOM_MARGIN * 2}px`);
    expect(a.style.zIndex).toBe('40');
    expect(a.style.boxShadow).toBe(LATH_ZOOM_SHADOW);
    // 'b' keeps its tiled rect beneath.
    expect(leafDiv('b')!.style.zIndex).toBe('0');
    expect(leafDiv('b')!.style.boxShadow).toBe('');

    act(() => store.setZoomed(null));
    const frames = layout(rowOf('a', 'b'), RECT, LATH_LAYOUT_OPTS);
    expect(leafDiv('a')!.style.width).toBe(`${frames.get('a')!.width}px`);
    expect(leafDiv('a')!.style.boxShadow).toBe('');
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

it('gives pane bodies the frame signal, for chrome portaled out of a moving pane', () => {
  let frames: unknown = null;
  function FramesBody() {
    frames = useContext(LayoutFramesContext);
    return null;
  }
  const engine = createLathWallEngine(seeded(rowOf('a'), [['a', leafMeta({ title: 'A' })]]), { durationMs: 0 });
  act(() => {
    root.render(
      <LathHost lath={engine} onCommitResize={vi.fn()} onLeafFocused={vi.fn()} componentsOverride={{ bodies: { terminal: FramesBody }, tabs: { terminal: StubTab } }} />,
    );
  });
  expect(frames).toBe(engine.subscribeFrames);
});

describe('LathHost — terminal context placement', () => {
  it('places the context from each painted frame before notifying chrome', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    const { engine } = mount(store);
    const element = document.createElement('div');
    const placedWidths: number[] = [];
    const seen: (ContextHelper | null)[] = [];
    const unsubscribe = engine.subscribeFrames(() => seen.push(engine.contextHelper()));
    act(() => engine.setContextPlacer(paint => {
      placedWidths.push(paint.get('a')!.rect.width);
      return { sourceId: 'a', element, side: 'right' };
    }));
    expect(seen.at(-1)).toEqual({ sourceId: 'a', element, side: 'right' });
    expect(`${placedWidths.at(-1)}px`).toBe(leafDiv('a')!.style.width);
    act(() => store.addLeaf('c', leafMeta({ title: 'C' }), { refId: 'b', edge: 'right' }));
    expect(`${placedWidths.at(-1)}px`).toBe(leafDiv('a')!.style.width);
    act(() => engine.setContextPlacer(null));
    expect(seen.at(-1)).toBeNull();
    unsubscribe();
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

  it('keeps the sash preview under the pointer while an earlier layout tween is running', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta()], ['b', leafMeta()]]);
    mount(store, vi.fn(), vi.fn(), DUR);
    act(() => store.addLeaf('c', leafMeta(), { refId: 'a', edge: 'right' }));
    clock += DUR / 4;
    flushRaf();
    const target = layout(store.getSnapshot().tree, RECT, LATH_LAYOUT_OPTS).get('a')!.width;
    const sash = container.querySelector<HTMLElement>('[data-lath-sash]')!;
    act(() => sash.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 10 })));
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 240, clientY: 10 })));
    flushRaf();
    expect(widthOf('a')).toBe(target + 40);
    clock += DUR / 4;
    flushRaf();
    expect(widthOf('a')).toBe(target + 40);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  });

  it('keeps a dragged pane dimmed across animation frames and preview renders', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta()], ['b', leafMeta()]]);
    mount(store, vi.fn(), vi.fn(), DUR);
    act(() => store.addLeaf('c', leafMeta(), { refId: 'a', edge: 'right' }));
    const header = leafDiv('a')!.querySelector<HTMLElement>('.lath-leaf-header')!;
    act(() => header.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 10 })));
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 700, clientY: 300 })));
    clock += DUR / 4;
    flushRaf();
    expect(leafDiv('a')!.style.opacity).toBe('0.6');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(leafDiv('a')!.style.opacity).toBe('');
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

  it('reattaches a parked leaf from its held rect instead of a collapsed viewport', () => {
    const initialTree = rowOf('a', 'b');
    const store = seeded(initialTree, [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    mount(store, vi.fn(), vi.fn(), DUR);
    const held = layout(initialTree, RECT, LATH_LAYOUT_OPTS).get('b')!;

    let token: ReturnType<LathWallStore['doorLeaf']>['token'] = null;
    act(() => { token = store.doorLeaf('b', { park: true }).token; });
    act(() => store.addLeaf('c', leafMeta({ title: 'C' }), { refId: 'a', edge: 'right' }));
    act(() => store.restoreLeaf(leafMeta({ title: 'B' }), token!, { fallbackRef: 'a' }));

    const target = layout(store.getSnapshot().tree, RECT, LATH_LAYOUT_OPTS).get('b')!;
    expect(target.width).not.toBeCloseTo(held.width, 1); // prove there is a real tween
    expect(parseFloat(leafDiv('b')!.style.left)).toBeCloseTo(held.x, 1);
    expect(widthOf('b')).toBeCloseTo(held.width, 1);
    expect(widthOf('b')).toBeGreaterThan(0);

    clock += DUR / 2;
    flushRaf();
    expect(widthOf('b')).toBeCloseTo(held.width + (target.width - held.width) * LATH_EASING(0.5), 0);
  });

  it('animates zoom above the tiled panes and stays elevated until unzoom settles', () => {
    const tree = rowOf('a', 'b');
    const store = seeded(tree, [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    mount(store, vi.fn(), vi.fn(), DUR);
    const tiled = layout(tree, RECT, LATH_LAYOUT_OPTS).get('a')!;
    const zoomed = {
      x: LATH_ZOOM_MARGIN,
      y: LATH_ZOOM_MARGIN,
      width: W - LATH_ZOOM_MARGIN * 2,
      height: H - LATH_ZOOM_MARGIN * 2,
    };

    act(() => store.setZoomed('a'));
    const a = leafDiv('a')!;
    // Elevation happens before expansion, so no overlapping frame paints under a
    // neighbor even at the transition's first instant.
    expect(parseFloat(a.style.left)).toBeCloseTo(tiled.x, 1);
    expect(widthOf('a')).toBeCloseTo(tiled.width, 1);
    expect(a.style.zIndex).toBe('40');
    expect(a.style.boxShadow).toBe(LATH_ZOOM_SHADOW);

    clock += DUR / 2;
    flushRaf();
    const eased = LATH_EASING(0.5);
    expect(parseFloat(a.style.left)).toBeCloseTo(tiled.x + (zoomed.x - tiled.x) * eased, 1);
    expect(widthOf('a')).toBeCloseTo(tiled.width + (zoomed.width - tiled.width) * eased, 1);
    expect(a.style.zIndex).toBe('40');

    clock += DUR / 2;
    flushRaf();
    expect(parseFloat(a.style.left)).toBeCloseTo(zoomed.x, 1);
    expect(widthOf('a')).toBeCloseTo(zoomed.width, 1);

    act(() => store.setZoomed(null));
    expect(a.style.zIndex).toBe('40');
    expect(a.style.boxShadow).toBe(LATH_ZOOM_SHADOW);
    clock += DUR / 2;
    flushRaf();
    expect(a.style.zIndex).toBe('40');
    expect(a.style.boxShadow).toBe(LATH_ZOOM_SHADOW);
    clock += DUR / 2;
    flushRaf();
    expect(widthOf('a')).toBeCloseTo(tiled.width, 1);
    expect(a.style.zIndex).toBe('0');
    expect(a.style.boxShadow).toBe('');
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

  it('fades a zoomed dying leaf while keeping its elevated inset geometry', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    const { engine } = mount(store, vi.fn(), vi.fn(), DUR);

    act(() => store.setZoomed('a'));
    clock += DUR;
    flushRaf();
    const a = leafDiv('a')!;
    expect(a.style.left).toBe(`${LATH_ZOOM_MARGIN}px`);
    expect(a.style.top).toBe(`${LATH_ZOOM_MARGIN}px`);
    expect(a.style.width).toBe(`${W - LATH_ZOOM_MARGIN * 2}px`);
    expect(a.style.height).toBe(`${H - LATH_ZOOM_MARGIN * 2}px`);

    act(() => engine.markDying('a'));
    expect(a.style.pointerEvents).toBe('none');
    expect(a.style.zIndex).toBe('40'); // elevated zoom stays above the dying band

    clock += DUR / 2;
    flushRaf();
    const mid = parseFloat(a.style.opacity);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(a.style.left).toBe(`${LATH_ZOOM_MARGIN}px`);
    expect(a.style.top).toBe(`${LATH_ZOOM_MARGIN}px`);
    expect(a.style.width).toBe(`${W - LATH_ZOOM_MARGIN * 2}px`);
    expect(a.style.height).toBe(`${H - LATH_ZOOM_MARGIN * 2}px`);
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
    act(() => window.dispatchEvent(new MouseEvent('pointerup', { clientX: 140, clientY: 10 })));

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
    props: { externalDrag?: { id: string; startX: number; startY: number } | null; workspaceDrag?: import('./surface-workspace-drag').SurfaceWorkspaceDrag } = {},
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
          workspaceDrag={props.workspaceDrag}
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
  let pointer = { clientX: 0, clientY: 0 };
  const moveTo = (x: number, y: number) => { pointer = { clientX: x, clientY: y }; window.dispatchEvent(new MouseEvent('pointermove', pointer)); };
  const up = () => window.dispatchEvent(new MouseEvent('pointerup', pointer));
  // Hold the pointer still long enough to anchor a slide.
  const pause = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, SLIDE_ARM_MS + 20)));
  const badge = () => container.querySelector('[data-lath-drop-choice]')?.textContent ?? null;

  // col[ row[a, b], c ]: dragging c onto a's top edge drops above 'a'; sliding along
  // that edge into b widens it to above the whole a|b row (its ancestor).
  function colRowTree(): LathTree {
    return { root: split('col', [split('row', [leaf('a'), 0.5], [leaf('b'), 0.5]), 0.5], [leaf('c'), 0.5]) };
  }

  it('lets the Workspace strip consume a pane release before local layout proposals and cancels on pointercancel', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta()], ['b', leafMeta()]]);
    const workspaceDrag = { hover: vi.fn(() => true), drop: vi.fn(() => true), end: vi.fn() };
    const { onProposeMove, onProposeMinimize } = mountDrag(store, { workspaceDrag });
    act(() => { down(header('a'), 100, 15); moveTo(601, 300); up(); });
    expect(workspaceDrag.drop).toHaveBeenCalledWith('a', 601, 300);
    expect(onProposeMove).not.toHaveBeenCalled();
    expect(onProposeMinimize).not.toHaveBeenCalled();
    workspaceDrag.drop.mockClear();
    act(() => { down(header('a'), 100, 15); moveTo(601, 300); window.dispatchEvent(new MouseEvent('pointercancel')); });
    expect(workspaceDrag.drop).not.toHaveBeenCalled();
    expect(workspaceDrag.end).toHaveBeenCalled();
    expect(overlayEl()).toBeNull();
  });

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

  it('commits the latest pointer position when release precedes the queued frame', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta()], ['b', leafMeta()]]);
    const { onProposeMove } = mountDrag(store);
    act(() => {
      down(header('a'), 100, 15);
      moveTo(601, 300);
      up();
    });
    expect(onProposeMove).toHaveBeenCalledWith('a', { kind: 'swap', leaf: 'b' });
  });

  it('resolves a release against a store commit before React has rendered it', async () => {
    const store = seeded(rowOf('a', 'b', 'c'), [['a', leafMeta()], ['b', leafMeta()], ['c', leafMeta()]]);
    const { onProposeMove } = mountDrag(store);
    act(() => down(header('a'), 100, 15));
    act(() => moveTo(400, 300)); // b's center
    await flushFrame();
    act(() => {
      store.swapLeaves('b', 'c');
      up(); // c now occupies this slot; React has not committed the snapshot yet
    });
    expect(onProposeMove).toHaveBeenCalledWith('a', { kind: 'swap', leaf: 'c' });
  });

  it('cancels a pane drag when the window loses focus', async () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta()], ['b', leafMeta()]]);
    const { onProposeMove } = mountDrag(store);
    act(() => down(header('a'), 100, 15));
    act(() => moveTo(601, 300));
    await flushFrame();
    act(() => window.dispatchEvent(new Event('blur')));
    expect(overlayEl()).toBeNull();
    act(() => up());
    expect(onProposeMove).not.toHaveBeenCalled();
  });

  it('cancels an external drop moved off-wall before its pending frame', async () => {
    const store = seeded(leafTree('a'), [['a', leafMeta()]]);
    const { onExternalDrop } = mountDrag(store, { externalDrag: { id: 'door', startX: 100, startY: 700 } });
    act(() => moveTo(5, 300));
    await flushFrame();
    expect(overlayEl()).not.toBeNull();
    act(() => {
      moveTo(100, 700);
      up();
    });
    expect(onExternalDrop).toHaveBeenCalledWith(null);
  });

  it('widens from one pane to its whole row by pausing on the edge and sliding along it', async () => {
    const t = colRowTree();
    const store = seeded(t, [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })], ['c', leafMeta({ title: 'C' })]]);
    const { onProposeMove } = mountDrag(store);

    // Drag c onto a's top edge (a spans y 0..~297, x 0..~397).
    act(() => down(header('c'), 100, 320)); // press on c's header (c is the bottom leaf)
    act(() => moveTo(100, 5)); // a's top band
    await flushFrame();
    expect(overlayRect()).toEqual(movePreview(t, 'c', { kind: 'edge', path: [0, 0], edge: 'top' }));
    expect(badge()).toBeNull();

    await pause();
    expect(badge()).toContain('one pane');
    expect(badge()).toContain('slide along the edge to widen');
    act(() => moveTo(600, 5)); // along the same line into b
    await flushFrame();
    expect(overlayRect()).toEqual(movePreview(t, 'c', { kind: 'edge', path: [0], edge: 'top' }));

    act(() => up());
    expect(onProposeMove).toHaveBeenCalledWith('c', { kind: 'edge', path: [0], edge: 'top' });
  });

  it('slides a contiguous group, outlines it, and commits it', async () => {
    const store = seeded(rowOf('a', 'b', 'c', 'd'), ['a', 'b', 'c', 'd'].map(id => [id, leafMeta()]));
    const { onProposeMove } = mountDrag(store);
    act(() => down(header('d'), 700, 15));
    act(() => moveTo(300, 60)); // b's top band, below the header row
    await flushFrame();
    await pause();
    expect(badge()).toContain('one pane');
    act(() => moveTo(100, 60)); // slide left into a
    await flushFrame();
    expect(badge()).toContain('2 panes');
    const target: DropTarget = { kind: 'edge', path: [], edge: 'top', range: { start: 0, end: 2 } };
    expect(overlayRect()).toEqual(movePreview(store.getSnapshot().tree, 'd', target));
    const scope = container.querySelector<HTMLElement>('[data-lath-drop-scope]')!;
    expect(parseFloat(scope.style.left)).toBe(0);
    expect(parseFloat(scope.style.width)).toBeGreaterThan(390);
    act(() => up());
    expect(onProposeMove).toHaveBeenCalledWith('d', target);
    expect(badge()).toBeNull();
  });

  it('drops beside one pane after a quick sweep along the headers', async () => {
    const store = seeded(rowOf('a', 'b', 'c', 'd'), ['a', 'b', 'c', 'd'].map(id => [id, leafMeta()]));
    const { onProposeMove } = mountDrag(store);
    act(() => down(header('d'), 700, 15));
    for (const x of [600, 500, 300]) {
      act(() => moveTo(x, 15));
      await flushFrame();
    }
    act(() => up());
    expect(onProposeMove).toHaveBeenCalledWith('d', { kind: 'edge', path: [1], edge: 'top' });
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

  it('swallows the click and dblclick a drag\'s release fires, never a sub-threshold press\'s', () => {
    const store = seeded(rowOf('a', 'b'), [['a', leafMeta({ title: 'A' })], ['b', leafMeta({ title: 'B' })]]);
    mountDrag(store);
    const seen: string[] = [];
    const record = (e: Event) => seen.push(`${e.type}:${(e as MouseEvent).detail}`);
    header('a').addEventListener('click', record);
    header('a').addEventListener('dblclick', record);
    // A double-click's second press: the browser fires both on its release.
    const release = () => {
      up();
      header('a').dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
      header('a').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    };

    act(() => down(header('a'), 100, 15));
    act(() => moveTo(120, 15));
    act(release);
    expect(seen).toEqual([]);

    act(() => down(header('a'), 100, 15));
    act(() => moveTo(102, 16));
    act(release);
    expect(seen).toEqual(['click:2', 'dblclick:2']);
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
