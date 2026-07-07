import { describe, expect, it } from 'vitest';
import { type LayoutOpts } from './layout';
import { hitTest } from './hit-test';
import { leaf, split as mk, tree, R, movePreview as movePreviewAt, insertPreview as insertPreviewAt } from './test-util';

const opts: LayoutOpts = { gap: 0, minLeaf: { width: 0, height: 0 } };
const RECT = R(0, 0, 1000, 600);
// Any placeholder id lays out identically to hitTest's internal external id, so the
// preview rect matches regardless of the label.
const X = 'X';

// Bind the shared preview helpers to this suite's rect + opts.
const movePreview = (t: ReturnType<typeof tree>, dragged: string, target: Parameters<typeof movePreviewAt>[2]) =>
  movePreviewAt(t, dragged, target, RECT, opts);
const insertPreview = (t: ReturnType<typeof tree>, target: Parameters<typeof insertPreviewAt>[2]) =>
  insertPreviewAt(t, X, target, RECT, opts);

describe('hitTest — center region', () => {
  it('yields a swap for an internal drag over a leaf center, previewed at the target rect', () => {
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    const cands = hitTest(t, RECT, { x: 250, y: 300 }, 'b', opts); // center of a
    expect(cands).toHaveLength(1);
    expect(cands[0].target).toEqual({ kind: 'swap', leaf: 'a' });
    expect(cands[0].depth).toBe(0);
    // b swapped onto a's slot.
    expect(cands[0].previewRect).toEqual(movePreview(t, 'b', { kind: 'swap', leaf: 'a' }));
    expect(cands[0].previewRect).toEqual(R(0, 0, 500, 600));
  });

  it('never swaps a leaf with itself (over the dragged leaf center → no candidates)', () => {
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    expect(hitTest(t, RECT, { x: 250, y: 300 }, 'a', opts)).toEqual([]);
  });
});

describe('hitTest — edge bands at the leaf level', () => {
  const t = tree(mk('row', [leaf('a'), 0.25], [leaf('b'), 0.5], [leaf('c'), 0.25]));
  // b spans x 250..750, full height 600.
  const cases: Array<{ edge: 'left' | 'right' | 'top' | 'bottom'; point: { x: number; y: number } }> = [
    { edge: 'left', point: { x: 260, y: 300 } },
    { edge: 'right', point: { x: 740, y: 300 } },
    { edge: 'top', point: { x: 500, y: 10 } },
    { edge: 'bottom', point: { x: 500, y: 590 } },
  ];
  for (const { edge, point } of cases) {
    it(`innermost candidate is the leaf-level ${edge} edge`, () => {
      const cands = hitTest(t, RECT, point, 'a', opts);
      expect(cands[0].target).toEqual({ kind: 'edge', path: [1], edge });
      expect(cands[0].depth).toBe(0);
      expect(cands[0].previewRect).toEqual(movePreview(t, 'a', { kind: 'edge', path: [1], edge }));
    });
  }
});

describe('hitTest — hierarchical depth (leaf + ancestors sharing a boundary)', () => {
  // row[ col[ row[a,b], c ], d ]: b's right edge coincides with its row Q ([0,0]),
  // its column P ([0]), but NOT the root (d is to the right).
  const t = tree(
    mk('row', [mk('col', [mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]), 0.5], [leaf('c'), 0.5]), 0.5], [leaf('d'), 0.5]),
  );

  it('yields leaf → ancestor → deeper-ancestor candidates in depth order (external drag)', () => {
    // External drag (dragged null): insert never perturbs the ancestry, so all three
    // coinciding levels survive as distinct results.
    const cands = hitTest(t, RECT, { x: 490, y: 150 }, null, opts); // b's right edge
    expect(cands.map((c) => c.target)).toEqual([
      { kind: 'edge', path: [0, 0, 1], edge: 'right' },
      { kind: 'edge', path: [0, 0], edge: 'right' },
      { kind: 'edge', path: [0], edge: 'right' },
    ]);
    expect(cands.map((c) => c.depth)).toEqual([0, 1, 2]);
    for (const c of cands) {
      expect(c.previewRect).toEqual(insertPreview(t, c.target));
    }
    // The three previews are genuinely different destinations.
    const keys = cands.map((c) => JSON.stringify(c.previewRect));
    expect(new Set(keys).size).toBe(3);
  });
});

describe('hitTest — band arithmetic at the caps', () => {
  it('caps a wide leaf band at 96px', () => {
    const t = tree(mk('row', [leaf('a'), 0.9], [leaf('b'), 0.1])); // a: 0..900
    // 0.3 * 900 = 270, capped to 96: x=95 is in-band (left edge), x=97 is center.
    expect(hitTest(t, RECT, { x: 95, y: 300 }, 'b', opts)[0].target).toEqual({ kind: 'edge', path: [0], edge: 'left' });
    expect(hitTest(t, RECT, { x: 97, y: 300 }, 'b', opts)[0].target).toEqual({ kind: 'swap', leaf: 'a' });
  });

  it('scales a small leaf band to 0.3 of its extent', () => {
    const small = R(0, 0, 200, 100);
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5])); // a: 0..100, band 30px
    expect(hitTest(t, small, { x: 29, y: 50 }, 'b', opts)[0].target).toEqual({ kind: 'edge', path: [0], edge: 'left' });
    expect(hitTest(t, small, { x: 31, y: 50 }, 'b', opts)[0].target).toEqual({ kind: 'swap', leaf: 'a' });
  });
});

describe('hitTest — self-target filtering', () => {
  const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));

  it("drops the dragged leaf's own edge candidates (beside itself is a no-op)", () => {
    expect(hitTest(t, RECT, { x: 490, y: 300 }, 'a', opts)).toEqual([]); // a's right edge
    expect(hitTest(t, RECT, { x: 10, y: 300 }, 'a', opts)).toEqual([]); // a's left edge (= root's)
  });
});

describe('hitTest — external drag', () => {
  const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));

  it('never yields a swap and previews via insert', () => {
    expect(hitTest(t, RECT, { x: 250, y: 300 }, null, opts)).toEqual([]); // center → no swap
    const cands = hitTest(t, RECT, { x: 510, y: 300 }, null, opts); // b's left edge
    expect(cands[0].target).toEqual({ kind: 'edge', path: [1], edge: 'left' });
    expect(cands[0].previewRect).toEqual(insertPreview(t, cands[0].target));
  });
});

describe('hitTest — misses', () => {
  const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));

  it('returns [] off the wall and for an empty tree', () => {
    expect(hitTest(t, RECT, { x: -5, y: 300 }, 'a', opts)).toEqual([]);
    expect(hitTest(t, RECT, { x: 1005, y: 300 }, 'a', opts)).toEqual([]);
    expect(hitTest(t, RECT, { x: 500, y: 700 }, 'a', opts)).toEqual([]);
    expect(hitTest(tree(null), RECT, { x: 100, y: 100 }, 'a', opts)).toEqual([]);
  });
});
