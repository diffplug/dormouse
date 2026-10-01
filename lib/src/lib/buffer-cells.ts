import type { IBufferCell, IBufferLine } from '@xterm/xterm';

/**
 * One string per cell column of `line`: the cell's characters, `' '` for an
 * empty cell, and `''` for the continuation half of a wide character. Combining
 * marks and emoji can make one cell several UTF-16 units. The one reading of
 * xterm cells that the smart-token detector and the copy editor share.
 */
export function readLineCells(line: IBufferLine): string[] {
  const cells: string[] = [];
  // One CellData for the whole row; `getCell` allocates per call otherwise.
  let scratch: IBufferCell | undefined;
  for (let c = 0; c < line.length; c++) {
    const cell = line.getCell(c, scratch);
    if (!cell) break;
    scratch ??= cell;
    cells.push(cell.getWidth() === 0 ? '' : cell.getChars() || ' ');
  }
  return cells;
}
