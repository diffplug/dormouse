/** A pointer position as the cell boundary nearest it: `b` is the gap before
 *  column `b`, from 0 to `cols`. */
export interface PointerBoundary { row: number; b: number }

export interface CellPos { row: number; col: number }

/** The boundary nearest `offsetX` in a grid of `cellWidth` cells; a pointer at
 *  a cell's exact middle takes the gap before it, as xterm.js's own selection
 *  does. */
export function boundaryAt(offsetX: number, cellWidth: number, cols: number): number {
  return Math.min(cols, Math.max(0, Math.ceil(offsetX / cellWidth - 0.5)));
}

/**
 * The inclusive cells a drag between two pointer boundaries selects
 * (docs/specs/mouse-and-clipboard.md §3.1): the earlier edge takes the cell
 * after its boundary, the later edge the cell before. Earlier is reading order
 * for a linewise drag and column order for a block. A drag whose edges meet
 * selects the one cell after them.
 */
export function dragCells(anchor: PointerBoundary, head: PointerBoundary, block: boolean, cols: number): { anchor: CellPos; head: CellPos } {
  const after = (p: PointerBoundary): CellPos => ({ row: p.row, col: Math.min(p.b, cols - 1) });
  if (block) {
    const left = Math.min(anchor.b, head.b);
    const right = Math.max(left, Math.max(anchor.b, head.b) - 1);
    const [a, h] = anchor.b <= head.b ? [left, right] : [right, left];
    return { anchor: { row: anchor.row, col: Math.min(a, cols - 1) }, head: { row: head.row, col: Math.min(h, cols - 1) } };
  }
  // A later edge at a row's first boundary ends the row above, at its last cell.
  const before = (p: PointerBoundary): CellPos => (p.b > 0 ? { row: p.row, col: p.b - 1 } : { row: p.row - 1, col: cols - 1 });
  const order = anchor.row - head.row || anchor.b - head.b;
  if (order === 0) return { anchor: after(anchor), head: after(head) };
  return order < 0 ? { anchor: after(anchor), head: before(head) } : { anchor: before(anchor), head: after(head) };
}
