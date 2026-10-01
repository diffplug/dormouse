import { describe, expect, it } from 'vitest';
import { boundaryAt, dragCells } from './drag-cells';

describe('boundaryAt', () => {
  it('takes the gap nearest the pointer, the one before a cell at its exact middle', () => {
    expect([4, 5, 6, 14, 16].map((x) => boundaryAt(x, 10, 80))).toEqual([0, 0, 1, 1, 2]);
  });

  it('stays inside the grid', () => {
    expect(boundaryAt(-30, 10, 80)).toBe(0);
    expect(boundaryAt(9_000, 10, 80)).toBe(80);
  });
});

describe('dragCells', () => {
  const cols = 80;

  it('gives the earlier edge the cell after it and the later edge the cell before', () => {
    expect(dragCells({ row: 0, b: 2 }, { row: 2, b: 6 }, false, cols)).toEqual({ anchor: { row: 0, col: 2 }, head: { row: 2, col: 5 } });
    expect(dragCells({ row: 2, b: 6 }, { row: 0, b: 2 }, false, cols)).toEqual({ anchor: { row: 2, col: 5 }, head: { row: 0, col: 2 } });
  });

  it('ends a drag at a row’s first gap on the row above', () => {
    expect(dragCells({ row: 0, b: 4 }, { row: 3, b: 0 }, false, cols)).toEqual({ anchor: { row: 0, col: 4 }, head: { row: 2, col: 79 } });
  });

  it('orders a block by column, whichever row each edge is on', () => {
    expect(dragCells({ row: 0, b: 10 }, { row: 3, b: 4 }, true, cols)).toEqual({ anchor: { row: 0, col: 9 }, head: { row: 3, col: 4 } });
    expect(dragCells({ row: 0, b: 10 }, { row: 3, b: 4 }, false, cols)).toEqual({ anchor: { row: 0, col: 10 }, head: { row: 3, col: 3 } });
  });

  it('selects the one cell after edges that meet', () => {
    expect(dragCells({ row: 1, b: 7 }, { row: 1, b: 7 }, false, cols)).toEqual({ anchor: { row: 1, col: 7 }, head: { row: 1, col: 7 } });
  });
});
