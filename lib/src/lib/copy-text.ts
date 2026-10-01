import type { Terminal } from '@xterm/xterm';
import { readLineCells } from './buffer-cells';
import type { Selection } from './mouse-selection';
import { normalizeSelection } from './selection-text';
import { detectTokenAt } from './smart-token';

// The text a copy produces: which cells a scope covers, and how each format
// turns them into clipboard text. Pure over a `CopyBuffer`, so the editor, the
// overlay, and the tests share one reading of the terminal
// (docs/specs/mouse-and-clipboard.md §4).

/** One buffer row: a string per cell column (`readLineCells`), trailing blanks
 *  trimmed. */
export interface CopyRow {
  readonly cells: readonly string[];
  /** xterm's `isWrapped`: a true soft wrap continuing the previous row. */
  readonly wrapped: boolean;
}

export interface CopyBuffer {
  readonly cols: number;
  readonly length: number;
  /** Out of range reads as an empty row. Returns the same object per index. */
  row(index: number): CopyRow;
}

const EMPTY_ROW: CopyRow = Object.freeze({ cells: Object.freeze([]) as readonly string[], wrapped: false });

function memoRows(length: number, read: (index: number) => CopyRow | null): (index: number) => CopyRow {
  const rows = new Map<number, CopyRow>();
  return (index) => {
    let row = rows.get(index);
    if (!row) {
      row = (index >= 0 && index < length ? read(index) : null) ?? EMPTY_ROW;
      rows.set(index, row);
    }
    return row;
  };
}

/** A lazily read, memoized view of a terminal's active buffer. Build one per
 *  read: it does not notice later output. */
export function terminalCopyBuffer(terminal: Terminal): CopyBuffer {
  const buffer = terminal.buffer.active;
  return {
    cols: terminal.cols,
    length: buffer.length,
    row: memoRows(buffer.length, (index) => {
      const line = buffer.getLine(index);
      return line ? { cells: trimTrailingBlanks(readLineCells(line)), wrapped: line.isWrapped } : null;
    }),
  };
}

/** A buffer over plain strings, one cell per code point; for tests and stories. */
export function stringCopyBuffer(lines: readonly string[], options: { cols: number; wrapped?: readonly number[] }): CopyBuffer {
  const wrapped = new Set(options.wrapped ?? []);
  return {
    cols: options.cols,
    length: lines.length,
    row: memoRows(lines.length, (index) => ({ cells: trimTrailingBlanks([...lines[index]]), wrapped: wrapped.has(index) })),
  };
}

function trimTrailingBlanks(cells: string[]): string[] {
  while (cells.length && /^\s*$/.test(cells[cells.length - 1])) cells.pop();
  return cells;
}

// ---------------------------------------------------------------------------
// Positions

export interface GridPos { row: number; col: number }
/** Inclusive end, `start` before `end` in reading order. */
export interface Span {
  start: GridPos;
  end: GridPos;
  /** A block-shape rectangle, not reading order (spec §3.2). */
  block: boolean;
}

export function comparePos(a: GridPos, b: GridPos): number {
  return a.row - b.row || a.col - b.col;
}

export function spanOfSelection(sel: Selection): Span {
  const n = normalizeSelection(sel);
  return { start: { row: n.r0, col: n.c0 }, end: { row: n.r1, col: n.c1 }, block: sel.shape === 'block' };
}

/** `base` moved to cover `span`, in reading order. */
export function selectionOfSpan(span: Span, base: Selection): Selection {
  return {
    ...base,
    startRow: span.start.row,
    startCol: span.start.col,
    endRow: span.end.row,
    endCol: span.end.col,
    shape: span.block ? 'block' : 'linewise',
  };
}

export function spanEquals(a: Span, b: Span): boolean {
  return comparePos(a.start, b.start) === 0 && comparePos(a.end, b.end) === 0 && a.block === b.block;
}

function contains(span: Span, row: number, col: number): boolean {
  if (span.block) {
    return row >= span.start.row && row <= span.end.row && col >= span.start.col && col <= span.end.col;
  }
  const p = { row, col };
  return comparePos(span.start, p) <= 0 && comparePos(p, span.end) <= 0;
}

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

/** Where `text`'s decoration sits, in UTF-16 units: `[blankFrom, blankTo)` is a
 *  leading marker to blank to spaces, and nothing from `keepTo` on is kept. */
function decoration(text: string): { blankFrom: number; blankTo: number; keepTo: number } {
  const lead = LEAD_MARKER.exec(text);
  const blankFrom = lead ? lead[1].length : 0;
  const blankTo = lead ? lead[0].length : 0;
  const trail = TRAIL_BOX.exec(text);
  return { blankFrom, blankTo, keepTo: Math.max(blankTo, trail ? trail.index : text.length) };
}

/** A row's facts every judgement reads, computed once per row. */
interface RowFacts {
  text: string;
  /** The text with its decoration blanked (spaces at the marker, so indents
   *  still line up with the columns under them) and trimmed. */
  plain: string;
  /** Blank, a frame, or a box's side: what bounds a paragraph. */
  boundary: boolean;
}

const rowFacts = new WeakMap<CopyRow, RowFacts>();

function facts(buf: CopyBuffer, r: number): RowFacts {
  const row = buf.row(r);
  let f = rowFacts.get(row);
  if (!f) {
    const text = row.cells.join('');
    const d = decoration(text);
    const plain = (text.slice(0, d.blankFrom) + ' '.repeat(d.blankTo - d.blankFrom) + text.slice(d.blankTo, d.keepTo)).trimEnd();
    f = { text, plain, boundary: !text.trim() || isFrameOnly(text) || /^[│┃║]/.test(text) };
    rowFacts.set(row, f);
  }
  return f;
}

const indentOf = (text: string) => text.length - text.trimStart().length;

/** Where a wrapped continuation of this row would start. */
function hangIndent(text: string): number {
  const indent = indentOf(text);
  const list = LIST_MARKER.exec(text.slice(indent));
  return indent + (list ? list[0].length : 0);
}

/** The width a program wrapped this row's paragraph at, as best the text says:
 *  its longest row, but never under half the terminal (rationale). */
function wrapWidth(buf: CopyBuffer, r: number): number {
  let top = r;
  while (top > 0 && top > r - 64 && !facts(buf, top - 1).boundary) top--;
  let bottom = r + 1;
  while (bottom + 1 < buf.length && bottom < r + 64 && !facts(buf, bottom + 1).boundary) bottom++;
  let widest = 0;
  for (let i = top; i <= bottom; i++) widest = Math.max(widest, facts(buf, i).plain.length);
  return Math.max(widest, Math.floor(buf.cols / 2));
}

export type BreakKind = 'keep' | 'space' | 'none';

/** Auto's judgement of the line break between rows `r` and `r + 1`. */
export function autoBreak(buf: CopyBuffer, r: number): BreakKind {
  if (r + 1 >= buf.length) return 'keep';
  if (buf.row(r + 1).wrapped) return 'none';
  const cur = facts(buf, r).plain;
  const next = facts(buf, r + 1).plain;
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

/** A buffer format, or the program's own `OSC 52` text (spec §4.6). */
export type EditorFormat = CopyFormat | 'program';

export type Piece =
  | { t: 'text'; text: string; added: boolean; lead: boolean }
  /** `auto` is the format's own decision, `kind` it after any override. */
  | { t: 'break'; index: number; kind: BreakKind; auto: BreakKind };

export interface Rendering {
  pieces: Piece[];
  text: string;
  lines: number;
}

interface Cell { ch: string; added: boolean }
interface Line { cells: Cell[]; row: number; startCol: number }

function extract(buf: CopyBuffer, scope: Span, original: Span): Line[] {
  const lines: Line[] = [];
  for (let r = scope.start.row; r <= scope.end.row; r++) {
    const cells = buf.row(r).cells;
    const a = scope.block || r === scope.start.row ? scope.start.col : 0;
    const b = scope.block || r === scope.end.row ? scope.end.col + 1 : cells.length;
    const out: Cell[] = [];
    for (let c = a; c < Math.min(b, cells.length); c++) {
      if (cells[c] !== '') out.push({ ch: cells[c], added: !contains(original, r, c) });
    }
    while (out.length && /^\s*$/.test(out[out.length - 1].ch)) out.pop();
    lines.push({ cells: out, row: r, startCol: a });
  }
  return lines;
}

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

/** The line with its decoration blanked, as `facts` blanks its row; null for a
 *  frame-only line. */
function stripDecoration(line: Line): Line | null {
  const text = line.cells.map((c) => c.ch).join('');
  if (isFrameOnly(text)) return null;
  const d = decoration(text);
  const from = cellsForChars(line.cells, d.blankFrom);
  const to = cellsForChars(line.cells, d.blankTo);
  const cells = line.cells.slice(0, cellsForChars(line.cells, d.keepTo)).map((c, k) => (k >= from && k < to ? { ...c, ch: ' ' } : c));
  while (cells.length && cells[cells.length - 1].ch === ' ') cells.pop();
  return { ...line, cells };
}

export interface RenderOptions {
  /** Cells inside the dragged selection; the rest of the scope is marked added. */
  original: Span;
  format: CopyFormat;
  /** Break index → kind, replacing the format's own decision. */
  overrides?: Readonly<Record<number, BreakKind>>;
}

export function render(buf: CopyBuffer, scope: Span, options: RenderOptions): Rendering {
  const { original, overrides = {} } = options;
  // Never rewrap a block slab (spec §4.1).
  const format = scope.block && options.format === 'auto' ? 'exact' : options.format;
  let lines = extract(buf, scope, original);
  const blank = (l: Line) => l.cells.length === 0;

  if (format !== 'exact') {
    lines = lines.map(stripDecoration).filter((l): l is Line => l !== null);
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
  const kinds: BreakKind[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i];
    const b = lines[i + 1];
    let auto: BreakKind;
    if (format === 'exact') auto = 'keep';
    else if (format === 'spaces') auto = 'space';
    else if (format === 'joined') auto = 'none';
    else auto = blank(a) || blank(b) || b.row !== a.row + 1 ? 'keep' : autoBreak(buf, a.row);
    autos.push(auto);
    kinds.push(overrides[i] ?? auto);
  }

  const pieces: Piece[] = [];
  let text = '';
  lines.forEach((line, i) => {
    const joined = i > 0 && kinds[i - 1] !== 'keep';
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
      const kind = kinds[i];
      pieces.push({ t: 'break', index: i, kind, auto: autos[i] });
      text += kind === 'keep' ? '\n' : kind === 'space' ? ' ' : '';
    }
  });

  return { pieces, text, lines: text ? text.split('\n').length : 0 };
}

/** Literal text as a rendering — a program's own copy — every line break
 *  kept unless overridden. */
export function renderText(text: string, overrides: Readonly<Record<number, BreakKind>> = {}): Rendering {
  const lines = text.split('\n');
  const pieces: Piece[] = [];
  let out = '';
  lines.forEach((raw, i) => {
    const line = i > 0 && (overrides[i - 1] ?? 'keep') !== 'keep' ? raw.trimStart() : raw;
    const lead = line.length - line.trimStart().length;
    if (lead) pieces.push({ t: 'text', text: line.slice(0, lead), added: false, lead: true });
    if (line.length > lead) pieces.push({ t: 'text', text: line.slice(lead), added: false, lead: false });
    out += line;
    if (i + 1 < lines.length) {
      const kind = overrides[i] ?? 'keep';
      pieces.push({ t: 'break', index: i, kind, auto: 'keep' });
      out += kind === 'keep' ? '\n' : kind === 'space' ? ' ' : '';
    }
  });
  return { pieces, text: out, lines: out ? out.split('\n').length : 0 };
}

// ---------------------------------------------------------------------------
// Scopes

/** `scopes[0]` is always the selection itself. */
export interface Scope { label: string; span: Span }

function contentStart(buf: CopyBuffer, r: number): number {
  return indentOf(facts(buf, r).plain);
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
  return { start: { row: sr, col: Math.max(0, sc) }, end: { row: er, col: Math.max(0, ec) }, block: false };
}

function toParagraph(buf: CopyBuffer, sel: Span): Span {
  let sr = sel.start.row;
  while (sr > 0 && !facts(buf, sr - 1).boundary) sr--;
  let er = sel.end.row;
  while (er + 1 < buf.length && !facts(buf, er + 1).boundary) er++;
  return {
    start: { row: sr, col: contentStart(buf, sr) },
    end: { row: er, col: Math.max(0, buf.row(er).cells.length - 1) },
    block: false,
  };
}

/** Names a growth by the edge tokens that grew, as the smart-token detector
 *  classifies them (spec §5.1). */
function wordsLabel(text: string, grewStart: boolean, grewEnd: boolean): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  const kinds = [grewStart ? tokens[0] : undefined, grewEnd ? tokens[tokens.length - 1] : undefined]
    .map((token) => (token ? detectTokenAt(token, 0)?.kind : undefined));
  if (kinds.includes('url')) return 'Full URL';
  if (kinds.includes('path')) return 'Full path';
  return 'Whole words';
}

/** Every distinct scope a selection can expand to, narrowest first. A wider
 *  scope always contains the dragged selection. A block slab only has itself. */
export function computeScopes(buf: CopyBuffer, sel: Span): Scope[] {
  const out: Scope[] = [{ label: 'As selected', span: sel }];
  if (sel.block) return out;
  const push = (label: string, span: Span) => {
    const union: Span = {
      start: comparePos(span.start, sel.start) < 0 ? span.start : sel.start,
      end: comparePos(span.end, sel.end) > 0 ? span.end : sel.end,
      block: false,
    };
    if (!out.some((s) => spanEquals(s.span, union))) out.push({ label, span: union });
  };
  const words = snapToWords(buf, sel);
  const grewStart = comparePos(words.start, sel.start) < 0;
  const grewEnd = comparePos(words.end, sel.end) > 0;
  push(wordsLabel(render(buf, words, { original: words, format: 'auto' }).text, grewStart, grewEnd), words);
  push('Paragraph', toParagraph(buf, sel));
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
