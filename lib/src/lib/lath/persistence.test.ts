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

  it('rejects malformed / non-layout blobs', () => {
    expect(isLathPersistedLayout(null)).toBe(false);
    expect(isLathPersistedLayout({ version: 2, tree: { root: null }, leafMeta: {} })).toBe(false);
    expect(isLathPersistedLayout({ version: 1, tree: {}, leafMeta: {} })).toBe(false); // no `root`
    expect(isLathPersistedLayout({ version: 1, tree: { root: null } })).toBe(false); // no leafMeta
  });
});
