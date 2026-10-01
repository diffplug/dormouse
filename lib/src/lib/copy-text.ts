import type { IBufferCell, Terminal } from '@xterm/xterm';
import type { Selection } from './mouse-selection';
import { normalizeSelection } from './selection-text';

// The text a copy produces: which cells a scope covers, and how each format
// turns them into clipboard text. Pure over a `CopyBuffer`, so the editor, the
// overlay, and the tests share one reading of the terminal
// (docs/specs/mouse-and-clipboard.md §4).

/** One buffer row: a string per cell column (`''` for the continuation half of
 *  a wide character), trailing blanks trimmed. */
export interface CopyRow {
  readonly cells: readonly string[];
  /** xterm's `isWrapped`: a true soft wrap continuing the previous row. */
  readonly wrapped: boolean;
}

export interface CopyBuffer {
  readonly cols: number;
  readonly length: number;
  /** Out of range reads as an empty row. */
  row(index: number): CopyRow;
}

const EMPTY_ROW: CopyRow = Object.freeze({ cells: Object.freeze([]) as readonly string[], wrapped: false });

/** A lazily read, memoized view of a terminal's active buffer. Build one per
 *  read: it does not notice later output. */
export function terminalCopyBuffer(terminal: Terminal): CopyBuffer {
  const buffer = terminal.buffer.active;
  const rows = new Map<number, CopyRow>();
  return {
    cols: terminal.cols,
    length: buffer.length,
    row(index) {
      const cached = rows.get(index);
      if (cached) return cached;
      const line = buffer.getLine(index);
      if (!line) return EMPTY_ROW;
      const cells: string[] = [];
      // One CellData for the whole row; `getCell` allocates per call otherwise.
      let scratch: IBufferCell | undefined;
      for (let c = 0; c < line.length; c++) {
        const cell = line.getCell(c, scratch);
        if (!cell) break;
        scratch ??= cell;
        cells.push(cell.getWidth() === 0 ? '' : cell.getChars() || ' ');
      }
      trimTrailingBlanks(cells);
      const row = { cells, wrapped: line.isWrapped };
      rows.set(index, row);
      return row;
    },
  };
}

/** A buffer over plain strings, one cell per code point; for tests and stories. */
export function stringCopyBuffer(lines: readonly string[], options: { cols?: number; wrapped?: readonly number[] } = {}): CopyBuffer {
  const wrapped = new Set(options.wrapped ?? []);
  const cols = options.cols ?? Math.max(0, ...lines.map((l) => l.length));
  return {
    cols,
    length: lines.length,
    row(index) {
      const line = lines[index];
      if (line === undefined) return EMPTY_ROW;
      const cells = [...line];
      trimTrailingBlanks(cells);
      return { cells, wrapped: wrapped.has(index) };
    },
  };
}

function trimTrailingBlanks(cells: string[]): void {
  while (cells.length && /^\s*$/.test(cells[cells.length - 1])) cells.pop();
}

// ---------------------------------------------------------------------------
// Positions

export interface GridPos { row: number; col: number }
/** Inclusive end, `start` before `end` in reading order. */
export interface Span { start: GridPos; end: GridPos }

export function comparePos(a: GridPos, b: GridPos): number {
  return a.row - b.row || a.col - b.col;
}

export function spanOfSelection(sel: Selection): Span {
  const n = normalizeSelection(sel);
  return { start: { row: n.r0, col: n.c0 }, end: { row: n.r1, col: n.c1 } };
}

export function spanEquals(a: Span, b: Span): boolean {
  return comparePos(a.start, b.start) === 0 && comparePos(a.end, b.end) === 0;
}

const rowText = (buf: CopyBuffer, r: number) => buf.row(r).cells.join('');
const isBlankCell = (ch: string | undefined) => ch === undefined || ch === ' ';

// ---------------------------------------------------------------------------
// Decoration and line breaks

const BOX = /[─-▟]/;
const FRAME_ONLY = /^[─-▟\s]+$/;
/** A TUI's line-leading glyph that is decoration, not text: Claude Code's reply
 *  and tool bullets, or a run of box drawing. */
const LEAD_MARKER = /^(\s*)(⏺ |⎿ |● |[─-▟]+ ?)/;
const TRAIL_BOX = / ?[─-▟]+$/;
const LIST_MARKER = /^(?:[-*•]|\d+[.)]) /;

function isFrameOnly(text: string): boolean {
  return text.length > 0 && FRAME_ONLY.test(text) && BOX.test(text);
}

/** The row with its decoration blanked to spaces, so indentation math still
 *  lines up with the columns under it. */
function unchromed(text: string): string {
  const lead = LEAD_MARKER.exec(text);
  const out = lead ? lead[1] + ' '.repeat(lead[2].length) + text.slice(lead[0].length) : text;
  return out.replace(TRAIL_BOX, '').trimEnd();
}

const indentOf = (text: string) => text.length - text.trimStart().length;

/** Where a wrapped continuation of this row would start. */
function hangIndent(text: string): number {
  const indent = indentOf(text);
  const list = LIST_MARKER.exec(text.slice(indent));
  return indent + (list ? list[0].length : 0);
}

/** A row that bounds a paragraph: blank, a frame, or a box's side. */
function isBoundary(buf: CopyBuffer, r: number): boolean {
  const text = rowText(buf, r);
  return !text.trim() || isFrameOnly(text) || /^[│┃║]/.test(text);
}

/** The width a program wrapped this row's paragraph at, as best the text says:
 *  its longest row, but never under half the terminal, so two short lines
 *  never read as one wrapped line. */
function wrapWidth(buf: CopyBuffer, r: number): number {
  let top = r;
  while (top > 0 && !isBoundary(buf, top - 1) && top > r - 64) top--;
  let bottom = r + 1;
  while (bottom + 1 < buf.length && !isBoundary(buf, bottom + 1) && bottom < r + 64) bottom++;
  let widest = 0;
  for (let i = top; i <= bottom; i++) widest = Math.max(widest, unchromed(rowText(buf, i)).length);
  return Math.max(widest, Math.floor(buf.cols / 2));
}

export type BreakKind = 'keep' | 'space' | 'none';

/** Auto's judgement of the line break between rows `r` and `r + 1`. */
export function autoBreak(buf: CopyBuffer, r: number): BreakKind {
  if (r + 1 >= buf.length) return 'keep';
  if (buf.row(r + 1).wrapped) return 'none';
  const cur = unchromed(rowText(buf, r));
  const next = unchromed(rowText(buf, r + 1));
  if (!cur.trim() || !next.trim()) return 'keep';
  const nextTrim = next.trimStart();
  if (LIST_MARKER.test(nextTrim)) return 'keep';
  if (/[;{}]$/.test(cur) || /^[)}\]]/.test(nextTrim)) return 'keep';
  if (indentOf(next) !== hangIndent(cur)) return 'keep';
  const firstWord = nextTrim.split(' ')[0];
  const width = wrapWidth(buf, r);
  // A break the next word would have fit before was typed, not wrapped.
  if (cur.length + 1 + firstWord.length <= width) return 'keep';
  const lastWord = cur.slice(cur.lastIndexOf(' ') + 1);
  const tokenish = /[/\\#?=&]/.test(lastWord) || /^[A-Za-z0-9+_\-.]{16,}$/.test(lastWord);
  // A token wider than the room left is split mid-token at the margin.
  return cur.length >= width && tokenish ? 'none' : 'space';
}

// ---------------------------------------------------------------------------
// Renderings

export type CopyFormat = 'auto' | 'exact' | 'spaces' | 'joined';

/** In `f` order; Auto is where every editor starts. */
export const COPY_FORMATS: readonly CopyFormat[] = ['auto', 'exact', 'spaces', 'joined'];

export type Piece =
  | { t: 'text'; text: string; added: boolean; lead: boolean }
  | { t: 'break'; index: number; kind: BreakKind; auto: BreakKind };

export interface Rendering {
  pieces: Piece[];
  text: string;
  lines: number;
  /** The format's own decision for each break, before any override. */
  breaks: BreakKind[];
}

interface Cell { ch: string; added: boolean }
interface Line { cells: Cell[]; row: number; startCol: number }

function inSpan(span: Span, row: number, col: number): boolean {
  const p = { row, col };
  return comparePos(span.start, p) <= 0 && comparePos(p, span.end) <= 0;
}

function extract(buf: CopyBuffer, scope: Span, original: Span, block: boolean): Line[] {
  const lines: Line[] = [];
  for (let r = scope.start.row; r <= scope.end.row; r++) {
    const cells = buf.row(r).cells;
    const a = block || r === scope.start.row ? scope.start.col : 0;
    const b = block || r === scope.end.row ? scope.end.col + 1 : cells.length;
    const out: Cell[] = [];
    for (let c = a; c < Math.min(b, cells.length); c++) {
      if (cells[c] === '') continue;
      const added = block
        ? !(r >= original.start.row && r <= original.end.row && c >= original.start.col && c <= original.end.col)
        : !inSpan(original, r, c);
      out.push({ ch: cells[c], added });
    }
    while (out.length && /^\s*$/.test(out[out.length - 1].ch)) out.pop();
    lines.push({ cells: out, row: r, startCol: a });
  }
  return lines;
}

const lineText = (l: Line) => l.cells.map((c) => c.ch).join('');
const leading = (cells: readonly Cell[]) => {
  let n = 0;
  while (n < cells.length && cells[n].ch === ' ') n++;
  return n;
};

/** Cells spanned by the first `chars` UTF-16 units of `cells`. */
function cellsForChars(cells: readonly Cell[], chars: number): number {
  let n = 0;
  for (let used = 0; n < cells.length && used < chars; n++) used += cells[n].ch.length;
  return n;
}

/** Blank the line's decoration the way `unchromed` does its row; null for a
 *  frame-only line. */
function stripChrome(line: Line): Line | null {
  const text = lineText(line);
  if (isFrameOnly(text)) return null;
  const cells = line.cells.map((c) => ({ ...c }));
  const lead = LEAD_MARKER.exec(text);
  if (lead) {
    const from = cellsForChars(cells, lead[1].length);
    const to = cellsForChars(cells, lead[0].length);
    for (let k = from; k < to; k++) cells[k].ch = ' ';
  }
  const trail = TRAIL_BOX.exec(text);
  if (trail) cells.length = cellsForChars(cells, trail.index);
  while (cells.length && cells[cells.length - 1].ch === ' ') cells.pop();
  return { ...line, cells };
}

export interface RenderOptions {
  /** Cells inside the dragged selection; the rest of `scope` is marked added. */
  original: Span;
  format: CopyFormat;
  /** A block-shape slab: never rewrapped, so Auto reads it exactly. */
  block?: boolean;
  /** Break index → kind, replacing the format's own decision. */
  overrides?: Readonly<Record<number, BreakKind>>;
}

export function render(buf: CopyBuffer, scope: Span, options: RenderOptions): Rendering {
  const { original, block = false, overrides = {} } = options;
  const format = block && options.format === 'auto' ? 'exact' : options.format;
  let lines = extract(buf, scope, original, block);
  const blank = (l: Line) => l.cells.length === 0;

  if (format !== 'exact') {
    lines = lines.map(stripChrome).filter((l): l is Line => l !== null);
    while (lines.length && blank(lines[0])) lines.shift();
    while (lines.length && blank(lines[lines.length - 1])) lines.pop();
    if (format === 'spaces' || format === 'joined') lines = lines.filter((l) => !blank(l));
    else lines = lines.filter((l, i) => !(blank(l) && i > 0 && blank(lines[i - 1])));
  }

  // Auto's shared indent, in absolute columns. A first line starting mid-row
  // has no indent of its own to keep.
  const indents = lines.filter((l) => !blank(l)).map((l) => l.startCol + leading(l.cells));
  const base = indents.length ? Math.min(...indents) : 0;

  const autos: BreakKind[] = [];
  const breaks: BreakKind[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i];
    const b = lines[i + 1];
    let auto: BreakKind;
    if (format === 'exact') auto = 'keep';
    else if (format === 'spaces') auto = 'space';
    else if (format === 'joined') auto = 'none';
    else auto = blank(a) || blank(b) || b.row !== a.row + 1 ? 'keep' : autoBreak(buf, a.row);
    autos.push(auto);
    breaks.push(overrides[i] ?? auto);
  }

  const pieces: Piece[] = [];
  let text = '';
  lines.forEach((line, i) => {
    const joined = i > 0 && breaks[i - 1] !== 'keep';
    const lead = leading(line.cells);
    let strip: number;
    if (format === 'exact') strip = joined ? lead : 0;
    else if (joined || format !== 'auto') strip = lead;
    else strip = line.startCol > base ? lead : Math.min(lead, base - line.startCol);
    const cells = line.cells.slice(strip);
    const leadRun = leading(cells);
    let run: Extract<Piece, { t: 'text' }> | null = null;
    cells.forEach((cell, k) => {
      const isLead = k < leadRun;
      if (run && run.added === cell.added && run.lead === isLead) run.text += cell.ch;
      else {
        run = { t: 'text', text: cell.ch, added: cell.added, lead: isLead };
        pieces.push(run);
      }
    });
    text += cells.map((c) => c.ch).join('');
    if (i + 1 < lines.length) {
      const kind = breaks[i];
      pieces.push({ t: 'break', index: i, kind, auto: autos[i] });
      text += kind === 'keep' ? '\n' : kind === 'space' ? ' ' : '';
    }
  });

  return { pieces, text, lines: text ? text.split('\n').length : 0, breaks: autos };
}

// ---------------------------------------------------------------------------
// Scopes

export type ScopeId = 'selection' | 'words' | 'paragraph';
export interface Scope { id: ScopeId; label: string; span: Span }

function contentStart(buf: CopyBuffer, r: number): number {
  return indentOf(unchromed(rowText(buf, r)));
}

/** Grow each edge over the whole token under it, following a token the
 *  program split across rows. */
function snapToWords(buf: CopyBuffer, sel: Span): Span {
  let { row: sr, col: sc } = sel.start;
  for (;;) {
    const cells = buf.row(sr).cells;
    while (sc > 0 && !isBlankCell(cells[sc - 1])) sc--;
    if (sc <= contentStart(buf, sr) && sr > 0 && !isBlankCell(cells[sc]) && autoBreak(buf, sr - 1) === 'none') {
      sr--;
      sc = buf.row(sr).cells.length;
      continue;
    }
    break;
  }
  let { row: er, col: ec } = sel.end;
  for (;;) {
    const cells = buf.row(er).cells;
    while (ec + 1 < cells.length && !isBlankCell(cells[ec + 1])) ec++;
    if (ec >= cells.length - 1 && !isBlankCell(cells[ec]) && autoBreak(buf, er) === 'none') {
      er++;
      ec = contentStart(buf, er) - 1;
      continue;
    }
    break;
  }
  return { start: { row: sr, col: Math.max(0, sc) }, end: { row: er, col: Math.max(0, ec) } };
}

function toParagraph(buf: CopyBuffer, sel: Span): Span {
  let sr = sel.start.row;
  while (sr > 0 && !isBoundary(buf, sr - 1)) sr--;
  let er = sel.end.row;
  while (er + 1 < buf.length && !isBoundary(buf, er + 1)) er++;
  return {
    start: { row: sr, col: contentStart(buf, sr) },
    end: { row: er, col: Math.max(0, buf.row(er).cells.length - 1) },
  };
}

/** Names a growth by the edge tokens that grew, not the whole text. */
function wordsLabel(text: string, grewStart: boolean, grewEnd: boolean): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  const edges = [grewStart ? tokens[0] : undefined, grewEnd ? tokens[tokens.length - 1] : undefined]
    .filter((t): t is string => !!t);
  if (edges.some((t) => /^https?:\/\//.test(t))) return 'Full URL';
  if (edges.some((t) => /^(?:~|\.{1,2})?\/\S|\S+\/\S+\.\w+/.test(t))) return 'Full path';
  return 'Whole words';
}

/** Every distinct scope a selection can expand to, narrowest first. A wider
 *  scope always contains the dragged selection. A block slab only has itself. */
export function computeScopes(buf: CopyBuffer, sel: Span, block = false): Scope[] {
  const out: Scope[] = [{ id: 'selection', label: 'As selected', span: sel }];
  if (block) return out;
  const push = (id: ScopeId, label: string, span: Span) => {
    const union: Span = {
      start: comparePos(span.start, sel.start) < 0 ? span.start : sel.start,
      end: comparePos(span.end, sel.end) > 0 ? span.end : sel.end,
    };
    if (out.some((s) => spanEquals(s.span, union))) return;
    out.push({ id, label, span: union });
  };
  const words = snapToWords(buf, sel);
  const grewStart = comparePos(words.start, sel.start) < 0;
  const grewEnd = comparePos(words.end, sel.end) > 0;
  push('words', wordsLabel(render(buf, words, { original: words, format: 'auto' }).text, grewStart, grewEnd), words);
  push('paragraph', 'Paragraph', toParagraph(buf, sel));
  return out;
}

// ---------------------------------------------------------------------------
// Nudging an edge a word at a time

function step(buf: CopyBuffer, p: GridPos, dir: 1 | -1): GridPos | null {
  let { row, col } = p;
  col += dir;
  for (;;) {
    const width = buf.row(row).cells.length;
    if (col >= 0 && col < width) return { row, col };
    row += dir;
    if (row < 0 || row >= buf.length) return null;
    col = dir > 0 ? 0 : buf.row(row).cells.length - 1;
  }
}

const cellAt = (buf: CopyBuffer, p: GridPos) => buf.row(p.row).cells[p.col];

/**
 * Move a selection edge one word in `dir`. `edge` says which side of a word it
 * rests on: a start lands on a word's first cell, an end on its last. A row
 * boundary ends a word.
 */
export function nudge(buf: CopyBuffer, p: GridPos, dir: 1 | -1, edge: 'start' | 'end'): GridPos {
  const leavingWord = (dir > 0) === (edge === 'start');
  let q = step(buf, p, dir);
  while (q && leavingWord && q.row === p.row && !isBlankCell(cellAt(buf, q))) q = step(buf, q, dir);
  while (q && isBlankCell(cellAt(buf, q))) q = step(buf, q, dir);
  if (!q) return p;
  // Walk to the requested side of the word `q` landed in.
  for (;;) {
    const n = step(buf, q, edge === 'end' ? 1 : -1);
    if (!n || n.row !== q.row || isBlankCell(cellAt(buf, n))) return q;
    q = n;
  }
}
