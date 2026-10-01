import type { IBufferCell, IBufferLine } from '@xterm/xterm';

/** What a soft-wrap walk reads of a buffer: an xterm `IBuffer`, or a slice
 *  of one. */
export interface BufferRows<L> {
  readonly length: number;
  getLine(r: number): L | undefined;
}

/** Row `r`, or undefined outside the buffer: xterm's `getLine` reads its ring
 *  cyclically past either end. */
export function lineAt<L>(buffer: BufferRows<L>, r: number): L | undefined {
  return r >= 0 && r < buffer.length ? buffer.getLine(r) : undefined;
}

/**
 * The rows of the logical line through row `r`, each read once: `lines[k]` is
 * row `top + k`, a soft wrap's rows read as one line. Reaches at most `reach`
 * rows either side of `r`, and holds no rows outside the buffer. The one walk
 * over soft wraps that every reader of the xterm buffer shares.
 */
export function wrapRun<L extends { readonly isWrapped: boolean }>(
  buffer: BufferRows<L>,
  r: number,
  reach = Infinity,
): { top: number; lines: L[] } {
  const line = lineAt(buffer, r);
  if (!line) return { top: r, lines: [] };
  const lines = [line];
  let top = r;
  // Trimmed scrollback can leave the buffer's first row a continuation.
  for (let first = line; first.isWrapped && r - top < reach;) {
    const above = lineAt(buffer, top - 1);
    if (!above) break;
    lines.push((first = above));
    top--;
  }
  lines.reverse();
  for (let next = lineAt(buffer, r + 1); next?.isWrapped && top + lines.length - 1 - r < reach; next = lineAt(buffer, top + lines.length)) {
    lines.push(next);
  }
  return { top, lines };
}

/** The cells of `line` its logical line's text holds: all but the blank xterm
 *  leaves when a wide character wraps to `next` rather than split. */
export function textWidth(line: IBufferLine, next: IBufferLine | undefined): number {
  if (!next?.isWrapped) return line.length;
  const last = line.getCell(line.length - 1);
  const padded = last?.getChars() === '' && last.getWidth() === 1 && next.getCell(0, last)?.getWidth() === 2;
  return line.length - (padded ? 1 : 0);
}

/**
 * One string per cell of `line` that {@link textWidth} counts: the cell's
 * characters, `' '` for an empty cell, and `''` for the continuation half of a
 * wide character. Combining marks and emoji can make one cell several UTF-16
 * units. The one reading of xterm cells that the smart-token detector and the
 * copy editor share.
 */
export function textCells(line: IBufferLine, next: IBufferLine | undefined): string[] {
  const cells: string[] = [];
  const width = textWidth(line, next);
  // One CellData for the whole row; `getCell` allocates per call otherwise.
  let scratch: IBufferCell | undefined;
  for (let c = 0; c < width; c++) {
    const cell = line.getCell(c, scratch);
    if (!cell) break;
    scratch ??= cell;
    cells.push(cell.getWidth() === 0 ? '' : cell.getChars() || ' ');
  }
  return cells;
}
