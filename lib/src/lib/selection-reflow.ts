import type { IBuffer, IBufferLine, IMarker, Terminal } from '@xterm/xterm';
import { readLineCells } from './buffer-cells';
import type { Selection } from './mouse-selection';
import { normalizeSelection } from './selection-text';

// A finalized linewise selection carried through the reflow of a terminal
// resize (docs/specs/mouse-and-clipboard.md §3.4). Each edge is a cell offset
// into its logical line, whose first row (not `isWrapped`) holds an xterm
// marker: reflow inserts and deletes only continuation rows after a line's
// first row, so the marker survives and moves with it.

interface EdgeAnchor {
  /** On the first row of the edge's logical line. */
  marker: IMarker;
  /** Text cells from that row's first, across the line's rows. */
  offset: number;
}

export interface ReflowAnchor {
  /** The earlier edge in reading order. */
  start: EdgeAnchor;
  end: EdgeAnchor;
  /** The cells the selection covers, as {@link reflowText} reads them. */
  text: string;
  dispose(): void;
}

interface Cell { row: number; col: number }

/** `getLine` reads the ring buffer cyclically past either end, and a marker
 *  trimmed off the top reads line -1. */
function rowAt(buffer: IBuffer, r: number): IBufferLine | undefined {
  return r >= 0 && r < buffer.length ? buffer.getLine(r) : undefined;
}

const continues = (buffer: IBuffer, r: number) => rowAt(buffer, r + 1)?.isWrapped === true;

/** Row `r`'s cells that belong to its logical line's text: all but the blank
 *  xterm leaves at a row's end when a wide character wraps to the next row,
 *  which reflow adds and removes. */
function textWidth(buffer: IBuffer, r: number): number {
  const line = rowAt(buffer, r)!;
  if (!continues(buffer, r)) return line.length;
  const last = line.getCell(line.length - 1);
  const padded = last?.getChars() === '' && last.getWidth() === 1 && rowAt(buffer, r + 1)!.getCell(0)?.getWidth() === 2;
  return padded ? line.length - 1 : line.length;
}

/** From `from` through `to`, soft wraps joined, wrap padding skipped, and each
 *  logical line's trailing blanks trimmed, so reflow alone never changes it. */
function reflowText(buffer: IBuffer, from: Cell, to: Cell): string {
  const lines: string[] = [];
  let line = '';
  for (let r = from.row; r <= to.row; r++) {
    const cells = readLineCells(rowAt(buffer, r)!);
    line += cells.slice(r === from.row ? from.col : 0, r === to.row ? to.col + 1 : textWidth(buffer, r)).join('');
    if (r === to.row || !continues(buffer, r)) {
      lines.push(line.replace(/\s+$/, ''));
      line = '';
    }
  }
  return lines.join('\n');
}

/** An edge on wrap padding moves to where the text resumes: the next row's
 *  first cell for a start, the cell before the padding for an end. */
function anchorEdge(terminal: Terminal, cell: Cell, edge: 'start' | 'end'): EdgeAnchor {
  const buffer = terminal.buffer.active;
  let first = cell.row;
  while (first > 0 && rowAt(buffer, first)!.isWrapped) first--;
  let offset = 0;
  for (let r = first; r < cell.row; r++) offset += textWidth(buffer, r);
  const width = textWidth(buffer, cell.row);
  offset += cell.col < width ? cell.col : edge === 'start' ? width : width - 1;
  // `registerMarker` counts from the cursor's row.
  return { marker: terminal.registerMarker(first - (buffer.baseY + buffer.cursorY)), offset };
}

/** Past its line's last row an offset stays on that row, at its last cell. */
function locateEdge(buffer: IBuffer, edge: EdgeAnchor): Cell | null {
  let row = edge.marker.line;
  if (!rowAt(buffer, row)) return null;
  for (let rest = edge.offset; ; row++) {
    const width = textWidth(buffer, row);
    if (rest < width || !continues(buffer, row)) return { row, col: Math.min(rest, rowAt(buffer, row)!.length - 1) };
    rest -= width;
  }
}

/** Anchor a finalized linewise selection Dormouse owns; null for anything a
 *  resize cancels. The alternate buffer never reflows, and its program
 *  redraws on resize. */
export function anchorSelection(terminal: Terminal, sel: Selection): ReflowAnchor | null {
  const buffer = terminal.buffer.active;
  if (sel.dragging || sel.shape === 'block' || sel.owner === 'program' || buffer.type !== 'normal') return null;
  const n = normalizeSelection(sel);
  const from = { row: n.r0, col: n.c0 };
  const to = { row: n.r1, col: n.c1 };
  if (!rowAt(buffer, from.row) || !rowAt(buffer, to.row)) return null;
  const start = anchorEdge(terminal, from, 'start');
  const end = anchorEdge(terminal, to, 'end');
  return {
    start,
    end,
    text: reflowText(buffer, from, to),
    dispose() {
      start.marker.dispose();
      end.marker.dispose();
    },
  };
}

/**
 * `sel` moved to where reflow put the cells under it, keeping its direction
 * and every other field. Null when either edge's line was trimmed away or the
 * cells there no longer read as `anchor.text`: that equality is a check, never
 * a search (spec §3.4).
 */
export function followReflow(terminal: Terminal, sel: Selection, anchor: ReflowAnchor): Selection | null {
  const buffer = terminal.buffer.active;
  if (buffer.type !== 'normal') return null;
  const from = locateEdge(buffer, anchor.start);
  const to = locateEdge(buffer, anchor.end);
  if (!from || !to || reflowText(buffer, from, to) !== anchor.text) return null;
  const forward = sel.startRow < sel.endRow || (sel.startRow === sel.endRow && sel.startCol <= sel.endCol);
  const [anchorCell, headCell] = forward ? [from, to] : [to, from];
  return { ...sel, startRow: anchorCell.row, startCol: anchorCell.col, endRow: headCell.row, endCol: headCell.col };
}
