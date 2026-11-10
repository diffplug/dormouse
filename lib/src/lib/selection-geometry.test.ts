import { describe, expect, it } from 'vitest';
import { computeRects, rectsToPath } from './selection-geometry';
import { normalizeSelection } from './selection-text';
import type { Selection } from './mouse-selection';

function sel(overrides: Partial<Selection>): Selection {
  return {
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    shape: 'linewise',
    dragging: false,
    ...overrides,
  };
}

describe('normalizeSelection', () => {
  it('forward linewise selection passes through', () => {
    const n = normalizeSelection(sel({ startRow: 2, startCol: 3, endRow: 5, endCol: 8 }));
    expect(n).toEqual({ r0: 2, c0: 3, r1: 5, c1: 8 });
  });

  it('reversed linewise selection swaps start/end', () => {
    const n = normalizeSelection(sel({ startRow: 5, startCol: 8, endRow: 2, endCol: 3 }));
    expect(n).toEqual({ r0: 2, c0: 3, r1: 5, c1: 8 });
  });

  it('block selection normalizes min/max independently', () => {
    const n = normalizeSelection(sel({
      startRow: 5, startCol: 8, endRow: 2, endCol: 3, shape: 'block',
    }));
    expect(n).toEqual({ r0: 2, c0: 3, r1: 5, c1: 8 });
  });
});

describe('computeRects: linewise', () => {
  const cellWidth = 10;
  const cellHeight = 20;

 it('single-row selection → one rect', () => {
   const rects = computeRects(
      sel({ startRow: 0, startCol: 5, endRow: 0, endCol: 14 }),
     80, 0, 24, cellWidth, cellHeight,
   );
    expect(rects).toEqual([{ top: 0, left: 50, width: 100, height: 20 }]);
  });

 it('multi-row linewise: first row trimmed, middle rows full, last row trimmed', () => {
   const rects = computeRects(
      sel({ startRow: 0, startCol: 5, endRow: 2, endCol: 9 }),
     80, 0, 24, cellWidth, cellHeight,
   );
    expect(rects).toHaveLength(3);
    expect(rects[0]).toEqual({ top: 0, left: 50, width: (80 - 5) * 10, height: 20 });
    expect(rects[1]).toEqual({ top: 20, left: 0, width: 800, height: 20 });
    expect(rects[2]).toEqual({ top: 40, left: 0, width: 100, height: 20 });
  });

  it('scrollback-only selection above viewport → no rects', () => {
    // viewportY=50 means visible rows are 50..73. Selection in rows 10..20
    // is entirely above the viewport.
   const rects = computeRects(
      sel({ startRow: 10, startCol: 0, endRow: 20, endCol: 9 }),
     80, 50, 24, cellWidth, cellHeight,
    );
    expect(rects).toEqual([]);
  });

  it('selection clipped to viewport start', () => {
    // viewportY=10 (rows 10..33). Selection 5..15 → only rows 10..15 visible.
   const rects = computeRects(
      sel({ startRow: 5, startCol: 0, endRow: 15, endCol: 39 }),
     80, 10, 24, cellWidth, cellHeight,
    );
    // First visible row is row 10 — that's a "middle" row (not the original
    // startRow), so full-width.
    expect(rects[0]).toEqual({ top: 0, left: 0, width: 800, height: 20 });
    // Last rect is the original endRow (15) in reading order.
    expect(rects[rects.length - 1]).toEqual({ top: (15 - 10) * 20, left: 0, width: 400, height: 20 });
  });

  it('selection with equal start/end columns renders one cell', () => {
   const rects = computeRects(
     sel({ startRow: 0, startCol: 10, endRow: 0, endCol: 10 }),
     80, 0, 24, cellWidth, cellHeight,
   );
    expect(rects).toEqual([{ top: 0, left: 100, width: 10, height: 20 }]);
 });
});

describe('computeRects: block', () => {
  const cellWidth = 10;
  const cellHeight = 20;

  it('block selection is a single rect', () => {
    const rects = computeRects(
      sel({ startRow: 0, startCol: 3, endRow: 2, endCol: 8, shape: 'block' }),
      80, 0, 24, cellWidth, cellHeight,
    );
    expect(rects).toHaveLength(1);
    expect(rects[0]).toEqual({ top: 0, left: 30, width: (8 - 3 + 1) * 10, height: (2 - 0 + 1) * 20 });
  });

  it('block selection clipped to viewport', () => {
    const rects = computeRects(
      sel({ startRow: 5, startCol: 3, endRow: 15, endCol: 8, shape: 'block' }),
      80, 10, 24, cellWidth, cellHeight,
    );
    expect(rects[0].top).toBe(0);
    expect(rects[0].height).toBe((15 - 10 + 1) * 20);
  });

  it('block selection entirely in scrollback → no rect', () => {
    const rects = computeRects(
      sel({ startRow: 0, startCol: 0, endRow: 5, endCol: 5, shape: 'block' }),
      80, 100, 24, cellWidth, cellHeight,
    );
    expect(rects).toEqual([]);
  });
});

describe('rectsToPath', () => {
  it('empty rect list → empty path', () => {
    expect(rectsToPath([])).toBe('');
  });

  it('single rect traces four corners', () => {
    // 20x10 rect at origin
    const path = rectsToPath([{ top: 0, left: 0, width: 20, height: 10 }]);
    // Right side going down, then left side going up (reversed).
    expect(path).toBe('M 20 0 L 20 10 L 0 10 L 0 0 Z');
  });

  it('two-row linewise "Z" shape — first row narrower, second wider', () => {
    // Row 0 is a tail: left=50, right=80 (narrower)
    // Row 1 starts at col 0: left=0, right=30 (head)
    const path = rectsToPath([
      { top: 0, left: 50, width: 30, height: 10 },
      { top: 10, left: 0, width: 30, height: 10 },
    ]);
    // Expected vertex walk:
    //   top-right of row 0 → bottom-right of row 0 (= top-right of connector)
    //   top-right of row 1 → bottom-right of row 1
    //   bottom-left of row 1 → top-left of row 1 (= bottom-left of connector)
    //   bottom-left of row 0 → top-left of row 0 → close
    expect(path).toBe(
      'M 80 0 L 80 10 L 30 10 L 30 20 L 0 20 L 0 10 L 50 10 L 50 0 Z',
    );
  });

  it('three-row linewise with full-width middle row', () => {
    const path = rectsToPath([
      { top: 0, left: 40, width: 40, height: 10 },   // row 0: tail, 40..80
      { top: 10, left: 0, width: 80, height: 10 },   // row 1: full, 0..80
      { top: 20, left: 0, width: 20, height: 10 },   // row 2: head, 0..20
    ]);
    expect(path).toBe(
      [
        'M 80 0',   // top-right of row 0
        'L 80 10',  // bottom-right of row 0
        'L 80 10',  // top-right of row 1 (same point, 0-length connector)
        'L 80 20',  // bottom-right of row 1
        'L 20 20',  // top-right of row 2
        'L 20 30',  // bottom-right of row 2
        'L 0 30',   // bottom-left of row 2
        'L 0 20',   // top-left of row 2
        'L 0 20',   // bottom-left of row 1 (same point)
        'L 0 10',   // top-left of row 1
        'L 40 10',  // bottom-left of row 0
        'L 40 0',   // top-left of row 0
        'Z',
      ].join(' '),
    );
  });

  it('block selection (single rect) — same as single rectangle', () => {
    const rects = computeRects(
      sel({ startRow: 0, startCol: 3, endRow: 2, endCol: 8, shape: 'block' }),
      80, 0, 24, 10, 20,
    );
    const path = rectsToPath(rects);
    // Rect: top=0, left=30, width=60, height=60 → right=90, bottom=60
    expect(path).toBe('M 90 0 L 90 60 L 30 60 L 30 0 Z');
  });
});
