/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LathHost, LATH_LAYOUT_OPTS } from './LathHost';
import { createLathWallStore, type LathWallStore, type LeafMeta } from './lath-wall-store';
import { layout } from '../../lib/lath/layout';
import type { LathNode, LathTree } from '../../lib/lath/model';
import type { PaneProps } from './pane-props';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const W = 800;
const H = 600;
const RECT = { x: 0, y: 0, width: W, height: H };

function meta(title: string, component = 'terminal', params?: Record<string, unknown>): LeafMeta {
  return { component, tabComponent: component === 'terminal' ? 'terminal' : 'surface', title, ...(params ? { params } : {}) };
}

/** a | b | c — a three-way row split at thirds. */
function rowOf(...ids: string[]): LathTree {
  return {
    root: {
      kind: 'split',
      dir: 'row',
      children: ids.map((id) => ({ node: { kind: 'leaf', id } as LathNode, weight: 1 / ids.length })),
    },
  };
}

// --- stub pane components (never mount the real TerminalPane/xterm) ---

let bodyProps: Record<string, PaneProps>;
let tabProps: Record<string, PaneProps>;

function StubBody(props: PaneProps) {
  bodyProps[props.id] = props;
  return <div data-body={props.id} />;
}
function StubTab(props: PaneProps) {
  tabProps[props.id] = props;
  return <div data-tab={props.id} />;
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

function mount(store: LathWallStore, onCommitResize = vi.fn(), onLeafFocused = vi.fn()) {
  act(() => {
    root.render(
      <LathHost store={store} onCommitResize={onCommitResize} onLeafFocused={onLeafFocused} componentsOverride={OVERRIDE} />,
    );
  });
  return { onCommitResize, onLeafFocused };
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
    const store = seeded(rowOf('a', 'b', 'c'), [['a', meta('A')], ['b', meta('B')], ['c', meta('C')]]);
    mount(store);

    const a0 = leafDiv('a');
    const b0 = leafDiv('b');
    const c0 = leafDiv('c');
    expect(a0 && b0 && c0).toBeTruthy();

    act(() => store.addLeaf('d', meta('D'), { refId: 'a', edge: 'right' }));
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
    const store = seeded(rowOf('c', 'a', 'b'), [['a', meta('A')], ['b', meta('B')], ['c', meta('C')]]);
    mount(store);
    expect(leafOrder()).toEqual(['a', 'b', 'c']);

    act(() => store.swapLeaves('a', 'c')); // changes layout order, not id set
    expect(leafOrder()).toEqual(['a', 'b', 'c']);
  });
});

describe('LathHost — frames applied to style', () => {
  it('lands each leaf rect from layout() in inline px that tiles the container', () => {
    const tree = rowOf('a', 'b', 'c');
    const store = seeded(tree, [['a', meta('A')], ['b', meta('B')], ['c', meta('C')]]);
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

  // Preview recompute is coalesced into one requestAnimationFrame per drag; flush a
  // frame so the pending preview commit lands before we assert on it.
  async function flushFrame() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  }

  it('previews the resize during the drag and commits once on pointerup', async () => {
    const store = seeded(rowOf('a', 'b', 'c'), [['a', meta('A')], ['b', meta('B')], ['c', meta('C')]]);
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
    const store = seeded(rowOf('a', 'b', 'c'), [['a', meta('A')], ['b', meta('B')], ['c', meta('C')]]);
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
    const store = seeded(rowOf('a', 'b'), [['a', meta('A')], ['b', meta('B')]]);
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
  it('supplies each body and tab { id, title, params, panelVisible: true } and getAnimEl → the leaf div', () => {
    const store = seeded(rowOf('a', 'b'), [
      ['a', meta('A')],
      ['b', meta('B', 'terminal', { url: 'x' })],
    ]);
    mount(store);

    expect(bodyProps['a']).toMatchObject({ id: 'a', title: 'A', panelVisible: true, params: undefined });
    expect(bodyProps['b']).toMatchObject({ id: 'b', title: 'B', panelVisible: true, params: { url: 'x' } });
    expect(tabProps['a']).toMatchObject({ id: 'a', title: 'A', panelVisible: true });

    // getAnimEl resolves to the leaf's own stable div.
    expect(bodyProps['a'].getAnimEl()).toBe(leafDiv('a'));
    expect(tabProps['b'].getAnimEl()).toBe(leafDiv('b'));
  });

  it('reports focusin inside a leaf via onLeafFocused', () => {
    const store = seeded(rowOf('a', 'b'), [['a', meta('A')], ['b', meta('B')]]);
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
