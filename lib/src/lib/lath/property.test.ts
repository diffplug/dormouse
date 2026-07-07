import { describe, expect, it } from 'vitest';
import {
  type Edge,
  type LathNode,
  type LathTree,
  findLeafPath,
  leafTree,
  leaves,
  nodeAtPath,
  validate,
} from './model';
import { type LayoutOpts, allocateChildSpans, layout, minSpan } from './layout';
import { type RestoreToken, move, remove, replace, resize, restore, split, swap } from './ops';

// Deterministic PRNG so failures are reproducible from the seed.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rng: () => number, n: number): number => Math.floor(rng() * n);
const pick = <T>(rng: () => number, arr: readonly T[]): T => arr[randInt(rng, arr.length)];
const R = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const EDGES: Edge[] = ['left', 'right', 'top', 'bottom'];

/** Build a random valid tree by splitting beside random leaves. */
function randomTree(rng: () => number, leafCount: number): { tree: LathTree; ids: string[] } {
  let tree = leafTree('L0');
  const ids = ['L0'];
  for (let i = 1; i < leafCount; i++) {
    const r = split(tree, pick(rng, ids), pick(rng, EDGES), `L${i}`);
    if (r.ok) {
      tree = r.tree;
      ids.push(`L${i}`);
    }
  }
  return { tree, ids };
}

function allPaths(root: LathNode | null): number[][] {
  const out: number[][] = [];
  const walk = (node: LathNode, path: number[]): void => {
    out.push(path);
    if (node.kind === 'split') node.children.forEach((c, i) => walk(c.node, [...path, i]));
  };
  if (root) walk(root, []);
  return out;
}
const splitPaths = (root: LathNode | null): number[][] =>
  allPaths(root).filter((p) => {
    const n = nodeAtPath({ root }, p);
    return n?.kind === 'split';
  });

describe('property: invariants across random op sequences', () => {
  it('every op leaves a valid tree; ok:false keeps the same object; leaf sets evolve as expected', () => {
    for (let s = 0; s < 300; s++) {
      const rng = mulberry32(1000 + s);
      let t = randomTree(rng, 1 + randInt(rng, 6)).tree;
      const live = new Set(leaves(t));
      let counter = 0;
      const tokens: RestoreToken[] = [];
      const rect = R(0, 0, 100 + randInt(rng, 900), 100 + randInt(rng, 500));
      const lopts: LayoutOpts = { gap: randInt(rng, 5), minLeaf: { width: randInt(rng, 20), height: randInt(rng, 20) } };

      for (let k = 0; k < 30; k++) {
        const before = t;
        const cur = leaves(t);
        const anyLeaf = (): string => (cur.length ? pick(rng, cur) : 'ghost');
        let res: { tree: LathTree; ok: boolean };

        switch (randInt(rng, 7)) {
          case 0: {
            const newId = rng() < 0.85 ? `N${counter++}` : anyLeaf(); // sometimes a duplicate
            const r = split(t, rng() < 0.85 ? anyLeaf() : 'ghost', pick(rng, EDGES), newId);
            if (r.ok) live.add(newId);
            res = r;
            break;
          }
          case 1: {
            const id = rng() < 0.85 ? anyLeaf() : 'ghost';
            const r = remove(t, id);
            if (r.ok) {
              live.delete(id);
              if (r.token) {
                tokens.push(r.token);
                // Every removed leaf's token restores somewhere while any leaf survives.
                const survivors = leaves(r.tree);
                const back = restore(
                  r.tree,
                  r.token,
                  survivors.length ? { fallbackRef: survivors[0], rect, layoutOpts: lopts } : undefined,
                );
                expect(back.ok).toBe(true);
              }
            }
            res = { tree: r.tree, ok: r.ok };
            break;
          }
          case 2: {
            const old = rng() < 0.85 ? anyLeaf() : 'ghost';
            const nid = rng() < 0.7 ? `N${counter++}` : anyLeaf();
            const r = replace(t, old, nid);
            if (r.ok) {
              live.delete(old);
              live.add(nid);
            }
            res = r;
            break;
          }
          case 3: {
            const a = anyLeaf();
            res = swap(t, a, rng() < 0.85 ? anyLeaf() : a); // leaf set unchanged
            break;
          }
          case 4: {
            const id = rng() < 0.85 ? anyLeaf() : 'ghost';
            if (rng() < 0.5) res = move(t, id, { kind: 'swap', leaf: anyLeaf() });
            else res = move(t, id, { kind: 'edge', path: pick(rng, allPaths(t.root)), edge: pick(rng, EDGES) });
            break; // leaf set unchanged
          }
          case 5: {
            const sp = splitPaths(t.root);
            if (sp.length) {
              const p = pick(rng, sp);
              const node = nodeAtPath(t, p);
              const boundary = node?.kind === 'split' ? randInt(rng, node.children.length - 1) : 0;
              res = resize(t, p, boundary, rng() * 400 - 200, rect, lopts);
            } else {
              res = resize(t, [9], 0, 10, rect, lopts); // deliberately invalid
            }
            break;
          }
          default: {
            if (tokens.length) {
              const tok = pick(rng, tokens);
              const survivors = leaves(t);
              const r = restore(
                t,
                tok,
                survivors.length ? { fallbackRef: survivors[0], rect, layoutOpts: lopts } : undefined,
              );
              if (r.ok) live.add(tok.leafId);
              res = { tree: r.tree, ok: r.ok };
            } else {
              res = { tree: t, ok: false };
            }
            break;
          }
        }

        t = res.tree;
        expect(validate(t)).toEqual([]);
        if (!res.ok) expect(res.tree).toBe(before);
        expect(new Set(leaves(t))).toEqual(live);
      }
    }
  });
});

describe('property: layout exactly tiles', () => {
  function assertTiling(node: LathNode, rect: ReturnType<typeof R>, lopts: LayoutOpts, map: Map<string, ReturnType<typeof R>>): void {
    if (node.kind === 'leaf') {
      expect(map.get(node.id)).toEqual(rect);
      return;
    }
    const isRow = node.dir === 'row';
    const span = isRow ? rect.width : rect.height;
    const near = isRow ? rect.x : rect.y;
    const n = node.children.length;
    const spans = allocateChildSpans(node.children, span, lopts, node.dir);
    for (const sp of spans) {
      expect(Number.isInteger(sp)).toBe(true);
      expect(sp).toBeGreaterThanOrEqual(0);
    }
    const available = span - lopts.gap * (n - 1);
    const sum = spans.reduce((a, b) => a + b, 0);
    if (available >= 0) {
      expect(sum).toBe(available); // exact partition: children + gaps == parent span
      const mins = node.children.map((c) => minSpan(c.node, node.dir, lopts));
      if (mins.reduce((a, b) => a + b, 0) <= available) {
        // min honored when feasible (±1 for integer rounding)
        for (let i = 0; i < n; i++) expect(spans[i]).toBeGreaterThanOrEqual(mins[i] - 1);
      }
    } else {
      expect(sum).toBe(0); // gaps exceed the span: clamp to zero, never crash
    }
    let pos = near;
    for (let i = 0; i < n; i++) {
      const childRect = isRow
        ? R(pos, rect.y, spans[i], rect.height)
        : R(rect.x, pos, rect.width, spans[i]);
      assertTiling(node.children[i].node, childRect, lopts, map);
      pos += spans[i] + lopts.gap;
    }
  }

  it('produces integer, non-overlapping, complete tilings over random trees and rects', () => {
    for (let s = 0; s < 200; s++) {
      const rng = mulberry32(5000 + s);
      const { tree } = randomTree(rng, 2 + randInt(rng, 6));
      const w = rng() < 0.2 ? randInt(rng, 6) : 20 + randInt(rng, 400); // sometimes tiny
      const h = rng() < 0.2 ? randInt(rng, 6) : 20 + randInt(rng, 300);
      const rect = R(randInt(rng, 20), randInt(rng, 20), w, h);
      const lopts: LayoutOpts = { gap: randInt(rng, 5), minLeaf: { width: randInt(rng, 25), height: randInt(rng, 25) } };
      const map = layout(tree, rect, lopts);
      const ids = leaves(tree);
      expect(map.size).toBe(ids.length);
      for (const id of ids) {
        const r = map.get(id)!;
        expect(Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.width) && Number.isInteger(r.height)).toBe(true);
        expect(r.width).toBeGreaterThanOrEqual(0);
        expect(r.height).toBeGreaterThanOrEqual(0);
      }
      if (tree.root) assertTiling(tree.root, rect, lopts, map);
    }
  });
});

describe('property: move edge beside a leaf ≡ remove + insert-beside', () => {
  it('keeps the leaf set, validates, and lands the moved leaf on the edge side of the target', () => {
    for (let s = 0; s < 200; s++) {
      const rng = mulberry32(9000 + s);
      const { tree, ids } = randomTree(rng, 3 + randInt(rng, 5));
      if (ids.length < 2) continue;
      const id = pick(rng, ids);
      const targetLeaf = pick(rng, ids.filter((x) => x !== id));
      const edge = pick(rng, EDGES);
      const out = move(tree, id, { kind: 'edge', path: findLeafPath(tree, targetLeaf)!, edge });

      expect(out.ok).toBe(true);
      expect(validate(out.tree)).toEqual([]);
      expect(new Set(leaves(out.tree))).toEqual(new Set(ids));

      const m = layout(out.tree, R(0, 0, 1000, 600), { gap: 0, minLeaf: { width: 0, height: 0 } });
      const mv = m.get(id)!;
      const tg = m.get(targetLeaf)!;
      if (edge === 'right') expect(mv.x).toBeGreaterThanOrEqual(tg.x + tg.width - 1);
      if (edge === 'left') expect(mv.x + mv.width).toBeLessThanOrEqual(tg.x + 1);
      if (edge === 'bottom') expect(mv.y).toBeGreaterThanOrEqual(tg.y + tg.height - 1);
      if (edge === 'top') expect(mv.y + mv.height).toBeLessThanOrEqual(tg.y + 1);
    }
  });
});
