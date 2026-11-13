import { describe, it, expect } from 'vitest';
import { isLathPersistedLayout, lathLayoutFromStore } from './persistence';
import type { LathTree } from './model';
import type { LeafMeta } from './persistence';
import { leafMeta as makeLeafMeta } from './test-fixtures';

describe('lathLayoutFromStore', () => {
  it('serializes a store snapshot to the persisted layout', () => {
    const tree: LathTree = { root: { kind: 'leaf', id: 'a' } };
    const leafMeta = new Map<string, LeafMeta>([['a', makeLeafMeta({ component: 'terminal', title: 'A' })]]);
    const out = lathLayoutFromStore({ tree, leafMeta });
    expect(out).toEqual({ version: 1, tree, leafMeta: { a: makeLeafMeta({ component: 'terminal', title: 'A' }) } });
  });
});

describe('isLathPersistedLayout', () => {
  it('accepts a well-formed layout', () => {
    expect(isLathPersistedLayout({ version: 1, tree: { root: null }, leafMeta: {} })).toBe(true);
    expect(
      isLathPersistedLayout({ version: 1, tree: { root: { kind: 'leaf', id: 'a' } }, leafMeta: { a: makeLeafMeta({ component: 'terminal', title: 'A' }) } }),
    ).toBe(true);
  });

  it.each([
    { root: {} },
    { root: { kind: 'leaf', id: 1 } },
    { root: { kind: 'split', dir: 'row' } },
    { root: { kind: 'split', dir: 'diagonal', children: [] } },
    { root: { kind: 'split', dir: 'row', children: [null, null] } },
    { root: { kind: 'split', dir: 'row', children: [
      { node: { kind: 'leaf', id: 'a' }, weight: NaN },
      { node: { kind: 'leaf', id: 'b' }, weight: 1 },
    ] } },
  ])('rejects malformed trees before typed traversal: %j', (tree) => {
    expect(isLathPersistedLayout({ version: 1, tree, leafMeta: {} })).toBe(false);
  });

  it('rejects cyclic trees', () => {
    const root = { kind: 'split', dir: 'row', children: [] as unknown[] };
    root.children.push({ node: root, weight: 0.5 }, { node: { kind: 'leaf', id: 'a' }, weight: 0.5 });
    expect(isLathPersistedLayout({ version: 1, tree: { root }, leafMeta: {} })).toBe(false);
  });

  it('requires valid metadata for exactly the tree leaves', () => {
    const tree = { root: { kind: 'leaf', id: 'a' } };
    for (const leafMeta of [{}, [], { b: makeLeafMeta() }, { a: null }, { a: { ...makeLeafMeta(), params: [] } }]) {
      expect(isLathPersistedLayout({ version: 1, tree, leafMeta })).toBe(false);
    }
  });

  it('rejects malformed / non-layout blobs', () => {
    expect(isLathPersistedLayout(null)).toBe(false);
    expect(isLathPersistedLayout({ version: 2, tree: { root: null }, leafMeta: {} })).toBe(false);
    expect(isLathPersistedLayout({ version: 1, tree: {}, leafMeta: {} })).toBe(false); // no `root`
    expect(isLathPersistedLayout({ version: 1, tree: { root: null } })).toBe(false); // no leafMeta
  });
});
