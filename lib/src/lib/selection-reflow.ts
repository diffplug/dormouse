import type { IBuffer, IMarker, Terminal } from '@xterm/xterm';
import { lineAt, textWidth, wrapRun } from './buffer-cells';
import { spanOfSelection, type GridPos, type Span } from './copy-text';
import type { Selection } from './mouse-selection';

// A finalized linewise selection carried through the reflow of a terminal
// resize (docs/specs/mouse-and-clipboard.md §3.4): each edge a cell offset
// into its logical line, from a marker on the line's first row (rationale).

interface EdgeAnchor {
  marker: IMarker;
  /** Text cells from the marker's row's first, across the line's rows. */
  offset: number;
}

/** An anchored selection, for {@link followReflow}. */
export interface ReflowAnchor { dispose(): void }

interface Anchor extends ReflowAnchor {
  /** The earlier edge in reading order. */
  start: EdgeAnchor;
  end: EdgeAnchor;
  /** The cells the selection covers, as {@link reflowText} reads them. */
  text: string;
}

/** From `from` through `to`, soft wraps joined, wrap padding skipped, and each
 *  logical line's trailing blanks trimmed; null past the buffer. */
function reflowText(buffer: IBuffer, from: GridPos, to: GridPos): string | null {
  const lines: string[] = [];
  let text = '';
  let line = lineAt(buffer, from.row);
  for (let r = from.row; r <= to.row; r++) {
    if (!line) return null;
    const next = lineAt(buffer, r + 1);
    text += line.translateToString(false, r === from.row ? from.col : 0, r === to.row ? to.col + 1 : textWidth(line, next));
    if (r === to.row || !next?.isWrapped) {
      lines.push(text.trimEnd());
      text = '';
    }
    line = next;
  }
  return lines.join('\n');
}

/** `pos` as an offset from its logical line's first row; null past the
 *  buffer. An edge on wrap padding moves to where the text resumes: the next
 *  row's first cell for a start, the cell before the padding for an end. */
function lineOffset(buffer: IBuffer, pos: GridPos, edge: 'start' | 'end'): { first: number; offset: number } | null {
  const { top, lines } = wrapRun(buffer, pos.row);
  const k = pos.row - top;
  if (!lines.length) return null;
  const width = textWidth(lines[k], lines[k + 1]);
  let offset = pos.col < width ? pos.col : edge === 'start' ? width : width - 1;
  for (let i = 0; i < k; i++) offset += textWidth(lines[i], lines[i + 1]);
  return { first: top, offset };
}

/** Past its line's last row an offset stays on that row, at its last cell. */
function locateEdge(buffer: IBuffer, edge: EdgeAnchor): GridPos | null {
  const { top, lines } = wrapRun(buffer, edge.marker.line);
  if (!lines.length) return null;
  for (let k = edge.marker.line - top, rest = edge.offset; ; k++) {
    const width = textWidth(lines[k], lines[k + 1]);
    if (rest < width || k + 1 === lines.length) return { row: top + k, col: Math.min(rest, lines[k].length - 1) };
    rest -= width;
  }
}

/** Anchor a finalized linewise selection Dormouse owns; null for anything a
 *  resize cancels. The alternate buffer never reflows, and its program
 *  redraws on resize. */
export function anchorSelection(terminal: Terminal, sel: Selection): ReflowAnchor | null {
  const buffer = terminal.buffer.active;
  if (sel.dragging || sel.shape === 'block' || sel.owner === 'program' || buffer.type !== 'normal') return null;
  const { start: from, end: to } = spanOfSelection(sel);
  const text = reflowText(buffer, from, to);
  const start = lineOffset(buffer, from, 'start');
  const end = lineOffset(buffer, to, 'end');
  if (text === null || !start || !end) return null;
  const mark = ({ first, offset }: { first: number; offset: number }): EdgeAnchor => ({
    // `registerMarker` counts from the cursor's row.
    marker: terminal.registerMarker(first - (buffer.baseY + buffer.cursorY)),
    offset,
  });
  const anchor: Anchor = {
    start: mark(start),
    end: mark(end),
    text,
    dispose() {
      anchor.start.marker.dispose();
      anchor.end.marker.dispose();
    },
  };
  return anchor;
}

/** Where reflow put the anchored cells; null when either edge's line was
 *  trimmed away or the cells there no longer read as `anchor`'s text. */
export function followReflow(terminal: Terminal, anchor: ReflowAnchor): Span | null {
  const buffer = terminal.buffer.active;
  if (buffer.type !== 'normal') return null;
  const { start, end, text } = anchor as Anchor;
  const from = locateEdge(buffer, start);
  const to = locateEdge(buffer, end);
  if (!from || !to || reflowText(buffer, from, to) !== text) return null;
  return { start: from, end: to, block: false };
}
