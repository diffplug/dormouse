import { describe, it, expect } from 'vitest';
import {
  createLathWallEngine,
  edgeForDorDirection,
  dorDirectionForEdge,
  edgeForDoorDirection,
  directionForArrow,
  leafMetaFromDoor,
  legacyTokenFromDoor,
} from './lath-wall-engine';
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

  it('maps door directions to lath edges', () => {
    expect(edgeForDoorDirection('above')).toBe('top');
    expect(edgeForDoorDirection('below')).toBe('bottom');
    expect(edgeForDoorDirection('right')).toBe('right');
    expect(edgeForDoorDirection('left')).toBe('left');
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

  it('canonicalizes legacy iframe/agent-browser component aliases to browser', () => {
    expect(leafMetaFromDoor({ ...base, component: 'iframe' }).component).toBe('browser');
    expect(leafMetaFromDoor({ ...base, component: 'agent-browser' }).component).toBe('browser');
  });

  it('passes browser/terminal through and defaults an absent component to terminal', () => {
    expect(leafMetaFromDoor({ ...base, component: 'browser' }).component).toBe('browser');
    expect(leafMetaFromDoor({ ...base, component: 'terminal' }).component).toBe('terminal');
    expect(leafMetaFromDoor(base).component).toBe('terminal');
  });

  it('minimizing a reattached legacy-alias door persists component "browser"', () => {
    // A pre-Lath door carrying the legacy `iframe` alias reattaches (leaf meta is
    // canonicalized here), so a subsequent minimize — which reads `meta.component`
    // straight through — persists the canonical `browser` value `reconnect.ts` filters on.
    const engine = createLathWallEngine();
    engine.seed(null, ['p1'], () => 'gen');
    const meta = leafMetaFromDoor({ ...base, id: 'legacy', component: 'iframe', params: { renderMode: 'iframe', url: 'x' } });
    engine.store.addLeaf('legacy', meta, { refId: 'p1', edge: 'right' });
    expect(engine.getMeta('legacy')?.component).toBe('browser');
  });
});

describe('legacyTokenFromDoor', () => {
  function door(overrides: Partial<DooredItem>): DooredItem {
    return {
      id: 'door-1',
      title: 'Door',
      neighborId: 'pane-x',
      direction: 'right',
      remainingPaneIds: [],
      layoutAtMinimize: null,
      layoutAtMinimizeSignature: '',
      ...overrides,
    } as DooredItem;
  }

  it('synthesizes a neighbor-tier token (no fingerprint) from {neighborId, direction}', () => {
    const token = legacyTokenFromDoor(door({ neighborId: 'pane-x', direction: 'below' }));
    expect(token).toEqual({
      leafId: 'door-1',
      weight: 0.5,
      siblingId: 'pane-x',
      edge: 'bottom', // 'below' → 'bottom'
      index: 0,
      fingerprint: null,
    });
  });

  it('carries a null neighbor (fallback tier at restore time)', () => {
    const token = legacyTokenFromDoor(door({ neighborId: null, direction: 'right' }));
    expect(token.siblingId).toBeNull();
    expect(token.edge).toBe('right');
    expect(token.fingerprint).toBeNull();
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
