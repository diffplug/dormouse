import type { IBuffer, IBufferLine, IMarker, Terminal } from '@xterm/xterm';
import { endsInWrapPadding, lineAt } from './buffer-cells';
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

/** The cells of `line` its logical line's text holds: all but wrap padding. */
const textWidth = (line: IBufferLine, next: IBufferLine | undefined) => line.length - (endsInWrapPadding(line, next) ? 1 : 0);

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
  let line = lineAt(buffer, pos.row);
  if (!line) return null;
  const width = textWidth(line, lineAt(buffer, pos.row + 1));
  let offset = pos.col < width ? pos.col : edge === 'start' ? width : width - 1;
  let first = pos.row;
  while (line.isWrapped) {
    const above = lineAt(buffer, first - 1);
    if (!above) break;
    offset += textWidth(above, line);
    line = above;
    first--;
  }
  return { first, offset };
}

/** Past its line's last row an offset stays on that row, at its last cell. */
function locateEdge(buffer: IBuffer, edge: EdgeAnchor): GridPos | null {
  let row = edge.marker.line;
  let line = lineAt(buffer, row);
  if (!line) return null;
  for (let rest = edge.offset; ; row++) {
    const next = lineAt(buffer, row + 1);
    const width = textWidth(line, next);
    if (rest < width || !next?.isWrapped) return { row, col: Math.min(rest, line.length - 1) };
    rest -= width;
    line = next;
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
