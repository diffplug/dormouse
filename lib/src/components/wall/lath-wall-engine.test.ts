import { describe, it, expect } from 'vitest';
import {
  createLathWallEngine,
  edgeForDorDirection,
  dorDirectionForEdge,
  doorDirectionForEdge,
  edgeForDoorDirection,
  directionForArrow,
  legacyTokenFromDoor,
} from './lath-wall-engine';
import type { DooredItem } from './wall-types';
import { leaves } from '../../lib/lath/model';
import { dockviewFixture } from './lath-test-fixtures';

describe('lath-wall-engine seed', () => {
  it('(a) hydrates from a LathPersistedLayout, preferring it over the dockview blob', () => {
    const engine = createLathWallEngine();
    const lathLayout = {
      version: 1 as const,
      tree: { root: { kind: 'leaf' as const, id: 'leaf-1' } },
      leafMeta: { 'leaf-1': { component: 'terminal', tabComponent: 'terminal', title: 'Restored' } },
    };
    const { paneIds, fresh } = engine.seed(lathLayout, dockviewFixture(), ['ignored'], () => 'gen');
    expect(fresh).toBe(false);
    expect(paneIds).toEqual(['leaf-1']);
    expect(engine.getMeta('leaf-1')?.title).toBe('Restored');
    expect(engine.has('pane-a')).toBe(false); // the dockview blob was NOT used
  });

  it('(b) migrates a legacy dockview blob when there is no lath layout', () => {
    const engine = createLathWallEngine();
    const { paneIds, fresh } = engine.seed(null, dockviewFixture(), ['pane-a', 'pane-b'], () => 'gen');
    expect(fresh).toBe(false);
    expect([...paneIds].sort()).toEqual(['pane-a', 'pane-b', 'pane-c']);
    expect(engine.getMeta('pane-a')?.title).toBe('A');
  });

  it('(c) builds a fresh tree from initialPaneIds when neither layout is usable', () => {
    const engine = createLathWallEngine();
    const { paneIds, fresh } = engine.seed(null, null, ['p1', 'p2'], () => 'gen');
    expect(fresh).toBe(true);
    expect([...paneIds].sort()).toEqual(['p1', 'p2']);
    expect(leaves(engine.store.getSnapshot().tree).sort()).toEqual(['p1', 'p2']);
    // Fresh leaves get the default terminal meta.
    expect(engine.getMeta('p1')).toMatchObject({ component: 'terminal', tabComponent: 'terminal' });
  });

  it('(c) generates a single pane id when initialPaneIds is empty', () => {
    const engine = createLathWallEngine();
    const { paneIds, fresh } = engine.seed(undefined, undefined, undefined, () => 'generated-1');
    expect(fresh).toBe(true);
    expect(paneIds).toEqual(['generated-1']);
  });

  it('falls through an empty-tree lath layout to fresh panes', () => {
    const engine = createLathWallEngine();
    const emptyLath = { version: 1 as const, tree: { root: null }, leafMeta: {} };
    const { paneIds, fresh } = engine.seed(emptyLath, null, ['p1'], () => 'gen');
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

  it('maps edges to door directions and back (inverse pair)', () => {
    expect(doorDirectionForEdge('top')).toBe('above');
    expect(doorDirectionForEdge('bottom')).toBe('below');
    expect(doorDirectionForEdge('right')).toBe('right');
    expect(doorDirectionForEdge('left')).toBe('left');
    for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
      expect(edgeForDoorDirection(doorDirectionForEdge(edge))).toBe(edge);
    }
  });

  it('maps keyboard arrows to lath directions', () => {
    expect(directionForArrow('ArrowLeft')).toBe('left');
    expect(directionForArrow('ArrowRight')).toBe('right');
    expect(directionForArrow('ArrowUp')).toBe('up');
    expect(directionForArrow('ArrowDown')).toBe('down');
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

describe('lath-wall-engine passthroughs', () => {
  it('lists panes in tree pre-order with meta, and restores from a token', () => {
    const engine = createLathWallEngine();
    engine.seed(null, null, ['p1'], () => 'gen');
    // Split p1 → p2 on the right (explicit edge, so no geometry is needed).
    engine.addLeaf('p2', { component: 'terminal', tabComponent: 'terminal', title: 'P2' }, { refId: 'p1', edge: 'right' });
    expect(engine.listPanes().map((p) => p.id).sort()).toEqual(['p1', 'p2']);

    // Minimize p2 → token; restore should reinstate it.
    const { token } = engine.removeLeaf('p2');
    expect(engine.has('p2')).toBe(false);
    expect(token).not.toBeNull();
    const meta = { component: 'terminal', tabComponent: 'terminal', title: 'P2' };
    const { ok } = engine.restoreLeaf(meta, token!, { fallbackRef: 'p1' });
    expect(ok).toBe(true);
    expect(engine.has('p2')).toBe(true);
  });
});
