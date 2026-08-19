import { describe, it, expect } from 'vitest';
import {
  createLathWallEngine,
  edgeForDorDirection,
  dorDirectionForEdge,
  directionForArrow,
  leafMetaFromDoor,
  shouldParkOnMinimize,
} from './lath-wall-engine';
import { MAX_PARKED_SURFACES } from './lath-wall-store';
import type { DooredItem } from './wall-types';
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

describe('leafMetaFromDoor', () => {
  const base: DooredItem = { id: 'door-1', title: 'Door' } as DooredItem;

  it('passes browser/terminal through and defaults an absent component to terminal', () => {
    expect(leafMetaFromDoor({ ...base, component: 'browser' }).component).toBe('browser');
    expect(leafMetaFromDoor({ ...base, component: 'terminal' }).component).toBe('terminal');
    expect(leafMetaFromDoor(base).component).toBe('terminal');
  });

});

describe('lath-wall-engine doorMeta', () => {
  const browser = { component: 'browser', tabComponent: 'surface', title: 'B' };

  it('prefers a parked Surface\'s live meta over the Door record snapshot', () => {
    const engine = createLathWallEngine();
    engine.seed(null, ['anchor'], () => 'gen');
    engine.store.addLeaf('b', browser, { refId: 'anchor', edge: 'right' });
    engine.store.parkLeaf('b');
    engine.store.updateParams('b', { url: 'https://after.example' });

    const door = { id: 'b', title: 'before', params: { url: 'https://before.example' } } as DooredItem;
    expect(engine.doorMeta(door).params).toEqual({ url: 'https://after.example' });
  });

  it('falls back to the Door record for an unparked door', () => {
    const engine = createLathWallEngine();
    engine.seed(null, ['anchor'], () => 'gen');
    const door = { id: 'gone', title: 'Door', params: { url: 'https://door.example' } } as DooredItem;
    expect(engine.doorMeta(door)).toEqual(leafMetaFromDoor(door));
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

  it('parkLeaf caps the parked set itself, evicting oldest-first', () => {
    const engine = createLathWallEngine();
    engine.seed(null, ['anchor'], () => 'gen');
    const ids: string[] = [];
    for (let i = 0; i < MAX_PARKED_SURFACES + 2; i++) {
      const id = `b${i}`;
      ids.push(id);
      engine.store.addLeaf(id, browser, { refId: 'anchor', edge: 'right' });
      engine.store.parkLeaf(id); // no companion eviction call to forget
    }
    const parked = engine.store.parkedIds();
    expect(parked).toHaveLength(MAX_PARKED_SURFACES);
    // The two oldest reverted to plain doors: still minimized, but they reattach by
    // reloading rather than by revealing preserved DOM.
    expect(parked).toEqual(ids.slice(2));
  });

  it('getMeta resolves a parked leaf, so a reattach restores its CURRENT meta', () => {
    const engine = createLathWallEngine();
    engine.seed(null, ['anchor'], () => 'gen');
    engine.store.addLeaf('b', browser, { refId: 'anchor', edge: 'right' });
    engine.store.parkLeaf('b');
    engine.store.updateParams('b', { url: 'http://localhost:3000/deep' });
    expect(engine.getMeta('b')?.params).toEqual({ url: 'http://localhost:3000/deep' });
    // ...but a parked leaf is not a visible pane.
    expect(engine.listPanes().map((p) => p.id)).toEqual(['anchor']);
  });

  it('leaves parked meta out of the persisted layout', () => {
    const engine = createLathWallEngine();
    engine.seed(null, ['anchor'], () => 'gen');
    engine.store.addLeaf('b', browser, { refId: 'anchor', edge: 'right' });
    engine.store.parkLeaf('b');
    const layout = engine.serializeLayout();
    expect(Object.keys(layout.leafMeta)).toEqual(['anchor']);
  });
});
