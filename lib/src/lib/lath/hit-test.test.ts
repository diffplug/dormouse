import { describe, expect, it } from 'vitest';
import { type LayoutOpts } from './layout';
import { hitTest } from './hit-test';
import { leaf, split as mk, tree, R, movePreview as movePreviewAt, insertPreview as insertPreviewAt } from './test-util';

const opts: LayoutOpts = { gap: 0, minLeaf: { width: 0, height: 0 } };
const RECT = R(0, 0, 1000, 600);
// Any placeholder id lays out identically to hitTest's internal external id, so the
// preview rect matches regardless of the label.
const X = 'X';
// The single drop at a point, with no slide anchored.
const drop = (...args: Parameters<typeof hitTest>) => hitTest(...args).candidate;

// Bind the shared preview helpers to this suite's rect + opts.
const movePreview = (t: ReturnType<typeof tree>, dragged: string, target: Parameters<typeof movePreviewAt>[2]) =>
  movePreviewAt(t, dragged, target, RECT, opts);
const insertPreview = (t: ReturnType<typeof tree>, target: Parameters<typeof insertPreviewAt>[2]) =>
  insertPreviewAt(t, X, target, RECT, opts);

describe('hitTest — center region', () => {
  it('yields a swap for an internal drag over a leaf center, previewed at the target rect', () => {
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    const c = drop(t, RECT, { x: 250, y: 300 }, 'b', opts)!; // center of a
    expect(c.target).toEqual({ kind: 'swap', leaf: 'a' });
    // b swapped onto a's slot.
    expect(c.previewRect).toEqual(movePreview(t, 'b', { kind: 'swap', leaf: 'a' }));
    expect(c.previewRect).toEqual(R(0, 0, 500, 600));
  });

  it('never swaps a leaf with itself (over the dragged leaf center → no candidates)', () => {
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    expect(drop(t, RECT, { x: 250, y: 300 }, 'a', opts)).toBeNull();
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
    it(`an unanchored ${edge} band drops beside the leaf itself`, () => {
      const dragged = edge === 'left' ? 'c' : 'a';
      const c = drop(t, RECT, point, dragged, opts)!;
      expect(c.target).toEqual({ kind: 'edge', path: [1], edge });
      expect(c.previewRect).toEqual(movePreview(t, dragged, { kind: 'edge', path: [1], edge }));
    });
  }
});

describe('hitTest — sliding along a shared boundary', () => {
  // row[ col[ row[a,b], c ], d ]: b's right edge lies on its column P's ([0]) right
  // boundary, which c's right edge shares; the root's right edge is d's.
  const t = tree(
    mk('row', [mk('col', [mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]), 0.5], [leaf('c'), 0.5]), 0.5], [leaf('d'), 0.5]),
  );
  const bRight = { x: 490, y: 150 };

  it('widens from the leaf to the whole column as the slide covers it (external drag)', () => {
    const alone = drop(t, RECT, bRight, null, opts)!;
    expect(alone.target).toEqual({ kind: 'edge', path: [0, 0, 1], edge: 'right' });
    expect(alone.canWiden).toBe(true);
    const hit = hitTest(t, RECT, { x: 490, y: 450 }, null, opts, bRight); // down onto c's right edge
    expect(hit.anchored).toBe(true);
    expect(hit.candidate!.target).toEqual({ kind: 'edge', path: [0], edge: 'right' });
    expect(hit.candidate!.previewRect).toEqual(insertPreview(t, { kind: 'edge', path: [0], edge: 'right' }));
    expect(hit.candidate!.scopeLeafCount).toBe(3);
    expect(hit.candidate!.canWiden).toBe(false); // P is the widest scope on this line
  });

  it('drops the anchor once the pointer leaves its line', () => {
    const hit = hitTest(t, RECT, { x: 510, y: 300 }, null, opts, bRight); // d's left edge, x 500
    expect(hit.anchored).toBe(false);
    expect(hit.candidate!.target).toEqual({ kind: 'edge', path: [1], edge: 'left' });
  });

  it('keeps the slide edge through a corner band', () => {
    const row = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    // At (495, 20) a's right band is nearer than its top band; the top slide continues.
    const hit = hitTest(row, RECT, { x: 495, y: 20 }, null, opts, { x: 100, y: 5 });
    expect(hit.anchored).toBe(true);
    expect(hit.candidate!.target).toEqual({ kind: 'edge', path: [0], edge: 'top' });
    expect(drop(row, RECT, { x: 495, y: 20 }, null, opts)!.target).toEqual({ kind: 'edge', path: [0], edge: 'right' });
  });
});

describe('hitTest — band arithmetic at the caps', () => {
  it('caps a wide leaf band at 96px', () => {
    const t = tree(mk('row', [leaf('a'), 0.9], [leaf('b'), 0.1])); // a: 0..900
    // 0.3 * 900 = 270, capped to 96: x=95 is in-band (left edge), x=97 is center.
    expect(drop(t, RECT, { x: 95, y: 300 }, 'b', opts)!.target).toEqual({ kind: 'edge', path: [0], edge: 'left' });
    expect(drop(t, RECT, { x: 97, y: 300 }, 'b', opts)!.target).toEqual({ kind: 'swap', leaf: 'a' });
  });

  it('scales a small leaf band to 0.3 of its extent', () => {
    const small = R(0, 0, 200, 100);
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5])); // a: 0..100, band 30px
    expect(drop(t, small, { x: 29, y: 50 }, 'b', opts)!.target).toEqual({ kind: 'edge', path: [0], edge: 'left' });
    expect(drop(t, small, { x: 31, y: 50 }, 'b', opts)!.target).toEqual({ kind: 'swap', leaf: 'a' });
  });
});

describe('hitTest — self-target filtering', () => {
  const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));

  it("drops the dragged leaf's own edge candidates (beside itself is a no-op)", () => {
    expect(drop(t, RECT, { x: 490, y: 300 }, 'a', opts)).toBeNull(); // a's right edge
    expect(drop(t, RECT, { x: 10, y: 300 }, 'a', opts)).toBeNull(); // a's left edge (= root's)
  });
});

describe('hitTest — external drag', () => {
  const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));

  it('never yields a swap and previews via insert', () => {
    expect(drop(t, RECT, { x: 250, y: 300 }, null, opts)).toBeNull(); // center → no swap
    const c = drop(t, RECT, { x: 510, y: 300 }, null, opts)!; // b's left edge
    expect(c.target).toEqual({ kind: 'edge', path: [1], edge: 'left' });
    expect(c.previewRect).toEqual(insertPreview(t, c.target));
  });
});

describe('hitTest — misses', () => {
  const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));

  it('returns null off the wall and for an empty tree', () => {
    expect(drop(t, RECT, { x: -5, y: 300 }, 'a', opts)).toBeNull();
    expect(drop(t, RECT, { x: 1005, y: 300 }, 'a', opts)).toBeNull();
    expect(drop(t, RECT, { x: 500, y: 700 }, 'a', opts)).toBeNull();
    expect(drop(tree(null), RECT, { x: 100, y: 100 }, 'a', opts)).toBeNull();
  });
});

it('filters a drop back at the same boundary in a three-pane row', () => {
  const t = tree(mk('row', [leaf('a'), 0.2], [leaf('b'), 0.3], [leaf('c'), 0.5]));
  expect(drop(t, RECT, { x: 199, y: 300 }, 'b', opts)).toBeNull();
});
