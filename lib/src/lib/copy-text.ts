import type { IBuffer, IBufferLine, Terminal } from '@xterm/xterm';
import { endsInWrapPadding, lineAt, readLineCells } from './buffer-cells';
import type { Selection } from './mouse-selection';
import { normalizeSelection } from './selection-text';
import { detectTokenAt } from './smart-token';

// The text a copy produces: which cells a scope covers, and how each format
// turns them into clipboard text. Pure over a `CopyBuffer`, so the editor, the
// overlay, and the tests share one reading of the terminal
// (docs/specs/mouse-and-clipboard.md §4).

/** One buffer row: a string per cell column (`readLineCells`). Trailing blanks
 *  are trimmed only where the text of the row's logical line ends: before a
 *  soft wrap that more text follows they are text, all but a wide character's
 *  wrap padding. */
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

/** A lazily read, memoized view of a terminal's active buffer: the copy
 *  editor keeps one per open, so its preview and its copy read the same rows. */
export function terminalCopyBuffer(terminal: Terminal): CopyBuffer {
  const buffer = terminal.buffer.active;
  const rows = new Map<number, CopyRow>();
  return {
    cols: terminal.cols,
    length: buffer.length,
    row(index) {
      let row = rows.get(index);
      if (!row) {
        const line = lineAt(buffer, index);
        row = line ? { cells: rowCells(buffer, index, line), wrapped: line.isWrapped } : EMPTY_ROW;
        rows.set(index, row);
      }
      return row;
    },
  };
}

function rowCells(buffer: IBuffer, index: number, line: IBufferLine): string[] {
  const cells = readLineCells(line);
  const next = lineAt(buffer, index + 1);
  if (textContinues(buffer, index + 1)) {
    if (endsInWrapPadding(line, next)) cells.pop();
    return cells;
  }
  while (cells.length && /^\s*$/.test(cells[cells.length - 1])) cells.pop();
  return cells;
}

/** Whether rows a soft wrap continues from row `r` on hold any text. */
function textContinues(buffer: IBuffer, r: number): boolean {
  for (let line = lineAt(buffer, r); line?.isWrapped; line = lineAt(buffer, ++r)) {
    if (/\S/.test(line.translateToString(true))) return true;
  }
  return false;
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

/** A logical line's facts every judgement reads, computed once per line: a
 *  soft wrap's rows are one line, indented as its first row (rationale). */
interface LineFacts {
  /** Its first and last rows. */
  top: number;
  bottom: number;
  /** The rows' text joined, as a deleted soft wrap joins them. */
  text: string;
  /** The text with its decoration blanked (spaces at the marker, so indents
   *  still line up with the columns under them) and trimmed. */
  plain: string;
  /** Blank, a frame, or a box's side: what bounds a paragraph. */
  boundary: boolean;
}

/** Each row's line, set for every row of the line at once. */
const lineFacts = new WeakMap<CopyRow, LineFacts>();

/** The logical line buffer row `r` is part of. */
function line(buf: CopyBuffer, r: number): LineFacts {
  const cached = lineFacts.get(buf.row(r));
  if (cached) return cached;
  let top = r;
  while (top > 0 && buf.row(top).wrapped) top--;
  let bottom = top;
  while (bottom + 1 < buf.length && buf.row(bottom + 1).wrapped) bottom++;
  let text = '';
  for (let i = top; i <= bottom; i++) text += buf.row(i).cells.join('');
  const d = decoration(text);
  const plain = (text.slice(0, d.blankFrom) + ' '.repeat(d.blankTo - d.blankFrom) + text.slice(d.blankTo, d.keepTo)).trimEnd();
  const f = { top, bottom, text, plain, boundary: !text.trim() || isFrameOnly(text) || /^[│┃║]/.test(text) };
  for (let i = top; i <= bottom; i++) lineFacts.set(buf.row(i), f);
  return f;
}

const indentOf = (text: string) => text.length - text.trimStart().length;

/** Where a wrapped continuation of this row would start. */
function hangIndent(text: string): number {
  const indent = indentOf(text);
  const list = LIST_MARKER.exec(text.slice(indent));
  return indent + (list ? list[0].length : 0);
}

/** The width a program wrapped the paragraph around the break after row `r`
 *  at, as best the text says: its longest line (rationale). */
function wrapWidth(buf: CopyBuffer, r: number): number {
  let above = line(buf, r);
  let below = line(buf, r + 1);
  let widest = Math.max(above.plain.length, below.plain.length);
  for (let n = 0; n < 64 && above.top > 0; n++) {
    above = line(buf, above.top - 1);
    if (above.boundary) break;
    widest = Math.max(widest, above.plain.length);
  }
  for (let n = 0; n < 64 && below.bottom + 1 < buf.length; n++) {
    below = line(buf, below.bottom + 1);
    if (below.boundary) break;
    widest = Math.max(widest, below.plain.length);
  }
  return widest;
}

/** A paragraph whose longest row is narrower than this was never wrapped:
 *  40 columns, or 60% of a narrower terminal (rationale). */
const minWrapWidth = (buf: CopyBuffer) => Math.min(40, Math.floor(buf.cols * 0.6));

export type BreakKind = 'keep' | 'space' | 'none';

/** Auto's judgement of the line break between rows `r` and `r + 1`. */
export function autoBreak(buf: CopyBuffer, r: number): BreakKind {
  if (r + 1 >= buf.length) return 'keep';
  if (buf.row(r + 1).wrapped) return 'none';
  // The line row `r` ends and the line row `r + 1` starts.
  const cur = line(buf, r).plain;
  const next = line(buf, r + 1).plain;
  if (!cur.trim() || !next.trim()) return 'keep';
  const nextTrim = next.trimStart();
  if (LIST_MARKER.test(nextTrim)) return 'keep';
  if (/[;{}]$/.test(cur) || /^[)}\]]/.test(nextTrim)) return 'keep';
  if (indentOf(next) !== hangIndent(cur)) return 'keep';
  const firstWord = nextTrim.split(' ')[0];
  const width = wrapWidth(buf, r);
  // A break the next word would have fit before was typed, not wrapped.
  if (width < minWrapWidth(buf) || cur.length + 1 + firstWord.length <= width) return 'keep';
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
}

/** What each break kind puts between two lines. */
const BREAK_TEXT: Record<BreakKind, string> = { keep: '\n', space: ' ', none: '' };
/** The formats whose every break is the same decision. */
const FIXED_BREAK: Partial<Record<CopyFormat, BreakKind>> = { exact: 'keep', spaces: 'space', joined: 'none' };

interface Cell { ch: string; added: boolean }
interface Line {
  /** Trailing blanks trimmed. */
  cells: Cell[];
  /** The blanks trimmed, which a deleted soft wrap puts back. */
  trail: Cell[];
  row: number;
  startCol: number;
}

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
    let end = out.length;
    while (end && /^\s*$/.test(out[end - 1].ch)) end--;
    lines.push({ cells: out.slice(0, end), trail: out.slice(end), row: r, startCol: a });
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

/** A scope's rows, read once for every format: as displayed, and with
 *  decoration stripped. */
export interface ScopeLines {
  buf: CopyBuffer;
  block: boolean;
  raw: readonly Line[];
  stripped: readonly Line[];
}

/** Read `scope`, marking every cell outside `original` (the dragged
 *  selection) as added. */
export function readScope(buf: CopyBuffer, scope: Span, original: Span): ScopeLines {
  const raw = extract(buf, scope, original);
  return { buf, block: scope.block, raw, stripped: raw.map(stripDecoration).filter((l): l is Line => l !== null) };
}

export function renderLines(scopeLines: ScopeLines, chosen: CopyFormat, overrides: Readonly<Record<number, BreakKind>> = {}): Rendering {
  const { buf, block } = scopeLines;
  // Never rewrap a block slab (spec §4.1).
  const format = block && chosen === 'auto' ? 'exact' : chosen;
  /** A row a soft wrap continues, whose start is wherever the wrap fell. */
  const continues = (l: Line) => !block && buf.row(l.row).wrapped;
  let lines = [...(format === 'exact' ? scopeLines.raw : scopeLines.stripped)];
  // A blank line is a logical line with no text in the scope: a blank row a
  // soft wrap joins to text is part of that text's line.
  const blanks = new Set<Line>();
  for (let i = 0; i < lines.length;) {
    let j = i + 1;
    while (j < lines.length && continues(lines[j]) && lines[j].row === lines[j - 1].row + 1) j++;
    const logical = lines.slice(i, j);
    if (logical.every((l) => l.cells.length === 0)) for (const l of logical) blanks.add(l);
    i = j;
  }
  const blank = (l: Line) => blanks.has(l);
  if (format !== 'exact') {
    while (lines.length && blank(lines[0])) lines.shift();
    while (lines.length && blank(lines[lines.length - 1])) lines.pop();
    if (format === 'spaces' || format === 'joined') lines = lines.filter((l) => !blank(l));
    else lines = lines.filter((l, i) => !(blank(l) && i > 0 && blank(lines[i - 1])));
  }

  // Auto's shared indent, in absolute columns. A first line starting mid-row,
  // or a row a soft wrap continues, has no indent of its own to keep.
  const indents = lines.filter((l) => !blank(l) && !continues(l)).map((l) => l.startCol + leading(l.cells));
  const base = indents.length ? Math.min(...indents) : 0;

  const pieces: Piece[] = [];
  let text = '';
  let joined = false;
  /** The break before this line deleted a soft wrap, which joins exactly. */
  let rejoined = false;
  lines.forEach((line, i) => {
    const next = lines[i + 1];
    const auto = !next ? 'keep' : FIXED_BREAK[format]
      ?? (blank(line) || blank(next) || next.row !== line.row + 1 ? 'keep' : autoBreak(buf, line.row));
    const kind = overrides[i] ?? auto;
    const rejoins = kind === 'none' && next?.row === line.row + 1 && continues(next);
    const lead = leading(line.cells);
    let strip: number;
    if (rejoined) strip = 0;
    else if (format === 'exact') strip = joined ? lead : 0;
    else if (joined || format !== 'auto') strip = lead;
    else strip = line.startCol > base || continues(line) ? lead : Math.min(lead, base - line.startCol);
    const cells = rejoins ? [...line.cells.slice(strip), ...line.trail] : line.cells.slice(strip);
    const leadRun = rejoined ? 0 : leading(cells);
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
    if (!next) return;
    pieces.push({ t: 'break', index: i, kind, auto });
    text += BREAK_TEXT[kind];
    joined = kind !== 'keep';
    rejoined = rejoins;
  });
  return { pieces, text };
}

export interface RenderOptions {
  /** Cells inside the dragged selection; the rest of the scope is marked added. */
  original: Span;
  format: CopyFormat;
  /** Break index → kind, replacing the format's own decision. */
  overrides?: Readonly<Record<number, BreakKind>>;
}

/** One format over one scope; `readScope` + `renderLines` when several
 *  formats share the scope. */
export function render(buf: CopyBuffer, scope: Span, options: RenderOptions): Rendering {
  return renderLines(readScope(buf, scope, options.original), options.format, options.overrides);
}

/** Literal text as a rendering — a program's own copy — every line break
 *  kept unless overridden. */
export function renderText(text: string, overrides: Readonly<Record<number, BreakKind>> = {}): Rendering {
  const lines = text.split('\n');
  const pieces: Piece[] = [];
  let out = '';
  let joined = false;
  lines.forEach((raw, i) => {
    // A joined line sheds its indent, as `render` sheds leading spaces.
    const line = joined ? raw.replace(/^ +/, '') : raw;
    const lead = line.length - line.replace(/^ +/, '').length;
    if (lead) pieces.push({ t: 'text', text: line.slice(0, lead), added: false, lead: true });
    if (line.length > lead) pieces.push({ t: 'text', text: line.slice(lead), added: false, lead: false });
    out += line;
    if (i + 1 < lines.length) {
      const kind = overrides[i] ?? 'keep';
      pieces.push({ t: 'break', index: i, kind, auto: 'keep' });
      out += BREAK_TEXT[kind];
      joined = kind !== 'keep';
    }
  });
  return { pieces, text: out };
}

// ---------------------------------------------------------------------------
// Scopes

/** `scopes[0]` is always the selection itself. */
export interface Scope { label: string; span: Span }

/** Where row `r`'s text starts: past its line's indent, or at the first cell
 *  of a row a soft wrap continues, which starts wherever the wrap fell. */
function contentStart(buf: CopyBuffer, r: number): number {
  return buf.row(r).wrapped ? 0 : indentOf(line(buf, r).plain);
}

/** Grow each edge over the whole token under it, following a token the
 *  program split across rows. */
function snapToWords(buf: CopyBuffer, sel: Span): Span {
  let { row: sr, col: sc } = sel.start;
  // An edge resting on a blank grows nothing: the word beside it was not clipped.
  // A token crosses a deleted break only with text on both sides of it, onto
  // the last cell of the row above or the first text cell of the row below.
  if (!isBlankCell(buf.row(sr).cells[sc])) {
    for (;;) {
      const cells = buf.row(sr).cells;
      while (sc > 0 && !isBlankCell(cells[sc - 1])) sc--;
      if (sc > contentStart(buf, sr) || sr === 0 || autoBreak(buf, sr - 1) !== 'none') break;
      const above = buf.row(sr - 1).cells;
      // A row a soft wrap continues keeps its trailing blank (`CopyRow`).
      if (isBlankCell(above[above.length - 1])) break;
      sr--;
      sc = above.length - 1;
    }
  }
  let { row: er, col: ec } = sel.end;
  if (!isBlankCell(buf.row(er).cells[ec])) {
    for (;;) {
      const cells = buf.row(er).cells;
      while (ec + 1 < cells.length && !isBlankCell(cells[ec + 1])) ec++;
      if (ec < cells.length - 1 || autoBreak(buf, er) !== 'none') break;
      const start = contentStart(buf, er + 1);
      if (isBlankCell(buf.row(er + 1).cells[start])) break;
      er++;
      ec = start;
    }
  }
  return { start: { row: sr, col: sc }, end: { row: er, col: ec }, block: false };
}

function toParagraph(buf: CopyBuffer, sel: Span): Span {
  let sr = sel.start.row;
  while (sr > 0 && !line(buf, sr - 1).boundary) sr--;
  let er = sel.end.row;
  while (er + 1 < buf.length && !line(buf, er + 1).boundary) er++;
  return {
    start: { row: sr, col: contentStart(buf, sr) },
    end: { row: er, col: Math.max(0, buf.row(er).cells.length - 1) },
    block: false,
  };
}

/** Names a growth by the edge tokens that grew, as the smart-token detector
 *  classifies them (spec §5.1). */
function wordsLabel(edgeTokens: readonly string[]): string {
  const kinds = edgeTokens.map((token) => detectTokenAt(token.trim(), 0)?.kind);
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
  // The token under a grown edge, rejoined as Auto would, names the growth.
  const tokenAt = (pos: GridPos) => {
    const token = snapToWords(buf, { start: pos, end: pos, block: false });
    return render(buf, token, { original: token, format: 'auto' }).text;
  };
  const edges = [
    ...(comparePos(words.start, sel.start) < 0 ? [tokenAt(words.start)] : []),
    ...(comparePos(words.end, sel.end) > 0 ? [tokenAt(words.end)] : []),
  ];
  if (edges.length) push(wordsLabel(edges), words);
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
