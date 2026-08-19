import { describe, it, expect } from 'vitest';
import {
  createLathWallEngine,
  edgeForDorDirection,
  dorDirectionForEdge,
  directionForArrow,
  leafMetaFromPersistedDoor,
  shouldParkOnMinimize,
} from './lath-wall-engine';
import { MAX_PARKED_SURFACES } from './lath-wall-store';
import type { PersistedDoor } from '../../lib/session-types';
import { leaves } from '../../lib/lath/model';

describe('lath-wall-engine seed', () => {
  it('(a) hydrates from a LathPersistedLayout, ignoring initialPaneIds', () => {
    const engine = createLathWallEngine();
    const lathLayout = {
      version: 1 as const,
      tree: { root: { kind: 'leaf' as const, id: 'leaf-1' } },
      leafMeta: { 'leaf-1': { component: 'terminal', tabComponent: 'terminal', title: 'Restored' } },
    };
    const { paneIds, fresh } = engine.seed(lathLayout, ['ignored'], () => 'gen');
    expect(fresh).toBe(false);
    expect(paneIds).toEqual(['leaf-1']);
    expect(engine.getMeta('leaf-1')?.title).toBe('Restored');
    expect(engine.store.has('ignored')).toBe(false);
  });

  it('(b) builds a fresh tree from initialPaneIds when the layout is not usable', () => {
    const engine = createLathWallEngine();
    const { paneIds, fresh } = engine.seed(null, ['p1', 'p2'], () => 'gen');
    expect(fresh).toBe(true);
    expect([...paneIds].sort()).toEqual(['p1', 'p2']);
    expect(leaves(engine.store.getSnapshot().tree).sort()).toEqual(['p1', 'p2']);
    // Fresh leaves get the default terminal meta.
    expect(engine.getMeta('p1')).toMatchObject({ component: 'terminal', tabComponent: 'terminal' });
  });

  it('(b) generates a single pane id when initialPaneIds is empty', () => {
    const engine = createLathWallEngine();
    const { paneIds, fresh } = engine.seed(undefined, undefined, () => 'generated-1');
    expect(fresh).toBe(true);
    expect(paneIds).toEqual(['generated-1']);
  });

  it('falls through an empty-tree lath layout to fresh panes', () => {
    const engine = createLathWallEngine();
    const emptyLath = { version: 1 as const, tree: { root: null }, leafMeta: {} };
    const { paneIds, fresh } = engine.seed(emptyLath, ['p1'], () => 'gen');
    expect(fresh).toBe(true);
    expect(paneIds).toEqual(['p1']);
  });
});

describe('lath-wall-engine edge/direction maps', () => {
  it('maps dor split directions to edges and back', () => {
    expect(edgeForDorDirection('left')).toBe('left');
    expect(edgeForDorDirection('right')).toBe('right');
    expect(edgeForDorDirection('up')).toBe('top');
    expect(edgeForDorDirection('down')).toBe('bottom');
    expect(dorDirectionForEdge('top')).toBe('up');
    expect(dorDirectionForEdge('bottom')).toBe('down');
    expect(dorDirectionForEdge('right')).toBe('right');
    expect(dorDirectionForEdge('left')).toBe('left');
  });

  it('maps keyboard arrows to lath directions', () => {
    expect(directionForArrow('ArrowLeft')).toBe('left');
    expect(directionForArrow('ArrowRight')).toBe('right');
    expect(directionForArrow('ArrowUp')).toBe('up');
    expect(directionForArrow('ArrowDown')).toBe('down');
  });
});

describe('leafMetaFromPersistedDoor', () => {
  const base: PersistedDoor = { id: 'door-1', title: 'Door' };

  it('passes browser/terminal through and defaults an absent component to terminal', () => {
    expect(leafMetaFromPersistedDoor({ ...base, component: 'browser' }).component).toBe('browser');
    expect(leafMetaFromPersistedDoor({ ...base, component: 'terminal' }).component).toBe('terminal');
    expect(leafMetaFromPersistedDoor(base).component).toBe('terminal');
  });
});

describe('lath-wall-engine door hydration', () => {
  it('seeds a restored Door\'s meta into the store, so nothing reads the wire row again', () => {
    const engine = createLathWallEngine();
    engine.seed(null, ['anchor'], () => 'gen', [
      { id: 'door-1', title: 'Restored', component: 'browser', tabComponent: 'surface', params: { url: 'https://restored.example' } },
    ]);
    // A Door is a detached leaf: it has meta, but it is not a pane...
    expect(engine.getMeta('door-1')).toMatchObject({ component: 'browser', params: { url: 'https://restored.example' } });
    expect(engine.listPanes().map((p) => p.id)).toEqual(['anchor']);
    // ...and it stays out of the persisted LAYOUT, which is the tree.
    expect(Object.keys(engine.serializeLayout().leafMeta)).toEqual(['anchor']);
  });

  it('seeds Doors alongside a restored Lath layout too', () => {
    const engine = createLathWallEngine();
    engine.seed(
      { version: 1, tree: { root: { kind: 'leaf', id: 'p1' } }, leafMeta: { p1: { component: 'terminal', tabComponent: 'terminal', title: 'P1' } } },
      undefined,
      () => 'gen',
      [{ id: 'door-1', title: 'Restored' }],
    );
    expect(engine.getMeta('p1')?.title).toBe('P1');
    expect(engine.getMeta('door-1')?.title).toBe('Restored');
  });
});

describe('lath-wall-engine listPanes projection', () => {
  it('lists panes in tree pre-order with meta as store state changes', () => {
    const engine = createLathWallEngine();
    engine.seed(null, ['p1'], () => 'gen');
    // Split p1 → p2 on the right (explicit edge, so no geometry is needed). State ops
    // go through the store; the engine's `listPanes` projection reflects them.
    engine.store.addLeaf('p2', { component: 'terminal', tabComponent: 'terminal', title: 'P2' }, { refId: 'p1', edge: 'right' });
    expect(engine.listPanes().map((p) => p.id).sort()).toEqual(['p1', 'p2']);

    // Minimize p2 → token; restore should reinstate it.
    const { token } = engine.store.removeLeaf('p2');
    expect(engine.store.has('p2')).toBe(false);
    expect(token).not.toBeNull();
    const meta = { component: 'terminal', tabComponent: 'terminal', title: 'P2' };
    const { ok } = engine.store.restoreLeaf(meta, token!, { fallbackRef: 'p1' });
    expect(ok).toBe(true);
    expect(engine.store.has('p2')).toBe(true);
  });
});

describe('lath-wall-engine parking policy', () => {
  const browser = { component: 'browser', tabComponent: 'surface', title: 'B' };
  const terminal = { component: 'terminal', tabComponent: 'terminal', title: 'T' };

  it('parks Surfaces whose state lives in the DOM, and only those', () => {
    expect(shouldParkOnMinimize(browser)).toBe(true);
    // A terminal's state is in the PTY and replays on reattach, so parking it would
    // only cost memory.
    expect(shouldParkOnMinimize(terminal)).toBe(false);
  });

  it('doorLeaf caps the parked DOM itself, evicting oldest-first', () => {
    const engine = createLathWallEngine();
    engine.seed(null, ['anchor'], () => 'gen');
    const ids: string[] = [];
    for (let i = 0; i < MAX_PARKED_SURFACES + 2; i++) {
      const id = `b${i}`;
      ids.push(id);
      engine.store.addLeaf(id, browser, { refId: 'anchor', edge: 'right' });
      engine.store.doorLeaf(id, { park: true }); // no companion eviction call to forget
    }
    const parked = engine.store.parkedIds();
    expect(parked).toHaveLength(MAX_PARKED_SURFACES);
    // The two oldest lost only their live DOM: they stay minimized and retain their
    // latest metadata, but reattach by reloading rather than revealing preserved DOM.
    expect(parked).toEqual(ids.slice(2));
    expect(engine.getMeta(ids[0])).toBeDefined();
  });

  it('keeps a Door\'s metadata live after the parked DOM is evicted', () => {
    const engine = createLathWallEngine();
    engine.seed(null, ['anchor'], () => 'gen');
    engine.store.addLeaf('oldest', browser, { refId: 'anchor', edge: 'right' });
    const { token } = engine.store.doorLeaf('oldest', { park: true });
    engine.store.updateParams('oldest', { url: 'https://after-park.example' });

    for (let i = 0; i < MAX_PARKED_SURFACES; i++) {
      const id = `newer-${i}`;
      engine.store.addLeaf(id, browser, { refId: 'anchor', edge: 'right' });
      engine.store.doorLeaf(id, { park: true });
    }

    expect(engine.getMeta('oldest')?.params).toEqual({ url: 'https://after-park.example' });

    // An async agent-browser acquisition may finish after the cap unmounted the DOM.
    engine.store.updateParams('oldest', { session: 'acquired-late' });
    expect(engine.getMeta('oldest')?.params).toEqual({
      url: 'https://after-park.example',
      session: 'acquired-late',
    });

    engine.store.restoreLeaf(engine.getMeta('oldest')!, token!, { fallbackRef: 'anchor' });
    expect(engine.getMeta('oldest')?.params).toEqual({
      url: 'https://after-park.example',
      session: 'acquired-late',
    });
  });

  it('getMeta resolves a Doored leaf, so a reattach restores its CURRENT meta', () => {
    const engine = createLathWallEngine();
    engine.seed(null, ['anchor'], () => 'gen');
    engine.store.addLeaf('b', browser, { refId: 'anchor', edge: 'right' });
    engine.store.doorLeaf('b', { park: true });
    engine.store.updateParams('b', { url: 'http://localhost:3000/deep' });
    expect(engine.getMeta('b')?.params).toEqual({ url: 'http://localhost:3000/deep' });
    // ...but a parked leaf is not a visible pane.
    expect(engine.listPanes().map((p) => p.id)).toEqual(['anchor']);
  });

  it('leaves Doored meta out of the persisted layout', () => {
    const engine = createLathWallEngine();
    engine.seed(null, ['anchor'], () => 'gen');
    engine.store.addLeaf('b', browser, { refId: 'anchor', edge: 'right' });
    engine.store.doorLeaf('b', { park: true });
    engine.store.addLeaf('t', terminal, { refId: 'anchor', edge: 'bottom' });
    engine.store.doorLeaf('t'); // unparked Door — same rule
    const layout = engine.serializeLayout();
    expect(Object.keys(layout.leafMeta)).toEqual(['anchor']);
  });
});
