import { describe, expect, it } from 'vitest';
import { type LayoutOpts } from './layout';
import { hitTest } from './hit-test';
import { leaf, split as mk, tree, R, movePreview as movePreviewAt, insertPreview as insertPreviewAt, landingPreview } from './test-util';

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
const landing = (t: ReturnType<typeof tree>, dragged: string, target: Parameters<typeof landingPreview>[2]) =>
  landingPreview(t, dragged, target, RECT, opts);

describe('hitTest — center region', () => {
  it('yields a swap for an internal drag over a leaf center, previewed at the target rect', () => {
    const t = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    const c = drop(t, RECT, { x: 250, y: 300 }, 'b', opts)!; // center of a
    expect(c.target).toEqual({ kind: 'swap', leaf: 'a' });
    // b swapped onto a's slot.
    expect(c.previewRect).toEqual(movePreview(t, 'b', { kind: 'swap', leaf: 'a' }));
    expect(c.previewRect).toEqual(R(0, 0, 500, 600));
    expect(c.swapRect).toEqual(R(500, 0, 500, 600)); // a takes b's slot
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
      expect(c.previewRect).toEqual(landing(t, dragged, { kind: 'edge', path: [1], edge }));
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

describe('hitTest — boundary lines', () => {
  // row[ a, col[b, c] ]: a 0..500; b above c on the right, meeting at y 300.
  const t = tree(mk('row', [leaf('a'), 0.5], [mk('col', [leaf('b'), 0.5], [leaf('c'), 0.5]), 0.5]));
  const right = { kind: 'edge', path: [], edge: 'right' } as const;

  it('drops across everything the line borders, and beside one pane in the band', () => {
    const line = drop(t, RECT, { x: 995, y: 450 }, 'a', opts)!;
    expect(line.target).toEqual(right);
    expect(line.previewRect).toEqual(R(500, 0, 500, 600));
    const band = drop(t, RECT, { x: 980, y: 450 }, 'a', opts)!;
    expect(band.target).toEqual({ kind: 'edge', path: [1, 1], edge: 'right' });
    // Half of c as it stands, not half of c once a's slot closes and c widens.
    expect(band.previewRect).toEqual(R(750, 300, 250, 300));
    expect(movePreview(t, 'a', band.target)).toEqual(R(500, 300, 500, 300));
  });

  it('reaches past the wall on its top and sides, but not below it', () => {
    expect(drop(t, RECT, { x: 1005, y: 450 }, 'a', opts)!.target).toEqual(right);
    expect(drop(t, RECT, { x: 750, y: -5 }, 'a', opts)!.target).toEqual({ kind: 'edge', path: [], edge: 'top' });
    expect(drop(t, RECT, { x: 750, y: 605 }, 'a', opts)).toBeNull();
  });

  it('starts a top line at the leaf, leaving its header to the band', () => {
    expect(drop(t, RECT, { x: 750, y: 3 }, 'a', opts)!.target).toEqual({ kind: 'edge', path: [1, 0], edge: 'top' });
  });

  it('spans a gutter across the group it bounds', () => {
    // col[ row[a, b], c ]: the a|b row's bottom is one line.
    const stack = tree(mk('col', [mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]), 0.5], [leaf('c'), 0.5]));
    expect(drop(stack, RECT, { x: 250, y: 295 }, null, opts)!.target).toEqual({ kind: 'edge', path: [0], edge: 'bottom' });
    expect(drop(stack, RECT, { x: 250, y: 280 }, null, opts)!.target).toEqual({ kind: 'edge', path: [0, 0], edge: 'bottom' });
  });

  it('keeps the line under half a small leaf band', () => {
    const small = R(0, 0, 40, 100); // b: 20..40, band 6px, line 3px
    const pair = tree(mk('row', [leaf('a'), 0.5], [leaf('b'), 0.5]));
    expect(drop(pair, small, { x: 36, y: 50 }, null, opts)!.target).toEqual({ kind: 'edge', path: [1], edge: 'right' });
    expect(drop(pair, small, { x: 38, y: 50 }, null, opts)!.target).toEqual({ kind: 'edge', path: [], edge: 'right' });
  });
});

describe('hitTest — band arithmetic', () => {
  it('divides a leaf into even thirds on each axis, swapping in the middle', () => {
    // a: 0..750 x 0..600, so its thirds fall at x 250 and 500, y 200 and 400.
    const t = tree(mk('row', [leaf('a'), 0.75], [mk('col', [leaf('b'), 0.5], [leaf('c'), 0.5]), 0.25]));
    const at = (x: number, y: number) => drop(t, RECT, { x, y }, 'c', opts)!.target;
    const swap = { kind: 'swap', leaf: 'a' };
    expect(at(249, 300)).toEqual({ kind: 'edge', path: [0], edge: 'left' });
    expect(at(251, 300)).toEqual(swap);
    expect(at(499, 300)).toEqual(swap);
    expect(at(501, 300)).toEqual({ kind: 'edge', path: [0], edge: 'right' });
    expect(at(375, 199)).toEqual({ kind: 'edge', path: [0], edge: 'top' });
    expect(at(375, 201)).toEqual(swap);
    expect(at(375, 399)).toEqual(swap);
    expect(at(375, 401)).toEqual({ kind: 'edge', path: [0], edge: 'bottom' });
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
    expect(drop(t, RECT, { x: -9, y: 300 }, 'b', opts)).toBeNull();
    expect(drop(t, RECT, { x: 1009, y: 300 }, 'a', opts)).toBeNull();
    expect(drop(t, RECT, { x: 500, y: -9 }, 'a', opts)).toBeNull();
    expect(drop(t, RECT, { x: 500, y: 700 }, 'a', opts)).toBeNull();
    expect(drop(tree(null), RECT, { x: 100, y: 100 }, 'a', opts)).toBeNull();
  });
});

it('filters a drop back at the same boundary in a three-pane row', () => {
  const t = tree(mk('row', [leaf('a'), 0.2], [leaf('b'), 0.3], [leaf('c'), 0.5]));
  expect(drop(t, RECT, { x: 199, y: 300 }, 'b', opts)).toBeNull();
});
