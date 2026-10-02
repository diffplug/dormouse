import type { IBuffer, Terminal } from '@xterm/xterm';
import { textCells, wrapRun } from './buffer-cells';
import type { Selection } from './mouse-selection';
import { normalizeSelection } from './selection-text';
import { detectTokenAt } from './smart-token';

// The text a copy produces: which cells a scope covers, and how each format
// turns them into clipboard text. Pure over a `CopyBuffer`, so the editor, the
// overlay, and the tests share one reading of the terminal
// (docs/specs/mouse-and-clipboard.md §4).

/** One buffer row: a string per cell column (`textCells`). Trailing blanks
 *  are trimmed only where the text of the row's logical line ends: before a
 *  soft wrap that more text follows they are text, all but a wide character's
 *  wrap padding. */
export interface CopyRow {
  readonly cells: readonly string[];
  /** xterm's `isWrapped`: a true soft wrap continuing the previous row. */
  readonly wrapped: boolean;
  /** The first and last rows of its logical line: the rows soft wraps join
   *  to it. */
  readonly top: number;
  readonly bottom: number;
}

export interface CopyBuffer {
  readonly cols: number;
  readonly length: number;
  /** Out of range reads as an empty row. Returns the same object per index. */
  row(index: number): CopyRow;
}

/** A lazily read, memoized view of a terminal's active buffer: the copy
 *  editor keeps one per open, so its preview and its copy read the same rows. */
export function terminalCopyBuffer(terminal: Terminal): CopyBuffer {
  const buffer = terminal.buffer.active;
  const rows = new Map<number, CopyRow>();
  return {
    cols: terminal.cols,
    length: buffer.length,
    row(index) {
      if (!rows.has(index)) readRows(buffer, index, rows);
      return rows.get(index)!;
    },
  };
}

/** Read every row of the logical line through row `index` into `rows` at
 *  once: whether a row keeps its trailing blanks depends on the rows after. */
function readRows(buffer: IBuffer, index: number, rows: Map<number, CopyRow>): void {
  const { top, lines } = wrapRun(buffer, index);
  if (!lines.length) {
    rows.set(index, { cells: [], wrapped: false, top: index, bottom: index });
    return;
  }
  const bottom = top + lines.length - 1;
  let textFollows = false;
  for (let k = lines.length - 1; k >= 0; k--) {
    const cells = textCells(lines[k], lines[k + 1]);
    const holdsText = cells.some((c) => /\S/.test(c));
    if (!textFollows) while (cells.length && /^\s*$/.test(cells[cells.length - 1])) cells.pop();
    rows.set(top + k, { cells, wrapped: lines[k].isWrapped, top, bottom });
    textFollows ||= holdsText;
  }
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
  /** The rows' text joined as a deleted soft wrap joins them, with its
   *  decoration blanked (spaces at the marker, so indents still line up with
   *  the columns under them) and trimmed. */
  plain: string;
  /** Blank, a frame, or a box's side: what bounds a paragraph. */
  boundary: boolean;
}

/** Each row's line, set for every row of the line at once. */
const lineFacts = new WeakMap<CopyRow, LineFacts>();

/** The logical line buffer row `r` is part of. */
function line(buf: CopyBuffer, r: number): LineFacts {
  const row = buf.row(r);
  const cached = lineFacts.get(row);
  if (cached) return cached;
  const { top, bottom } = row;
  let text = '';
  for (let i = top; i <= bottom; i++) text += buf.row(i).cells.join('');
  const d = decoration(text);
  const plain = (text.slice(0, d.blankFrom) + ' '.repeat(d.blankTo - d.blankFrom) + text.slice(d.blankTo, d.keepTo)).trimEnd();
  const f = { top, bottom, plain, boundary: !text.trim() || isFrameOnly(text) || /^[│┃║]/.test(text) };
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

/** How many lines `wrapWidth` reads either side of a break, bounding its
 *  work. */
const WIDTH_REACH = 64;

/** The lines from `from` on in `dir`, up to a boundary, the buffer's edge, or
 *  {@link WIDTH_REACH} of them. */
function paragraphLines(buf: CopyBuffer, from: LineFacts, dir: 1 | -1): LineFacts[] {
  const out: LineFacts[] = [];
  for (let at = from; out.length < WIDTH_REACH;) {
    const r = dir < 0 ? at.top - 1 : at.bottom + 1;
    if (r < 0 || r >= buf.length) break;
    at = line(buf, r);
    if (at.boundary) break;
    out.push(at);
  }
  return out;
}

/** A paragraph's widest line, by each of its lines, once one break's walks
 *  read the whole of it: with the line's index and the paragraph's size. */
const paragraphWidth = new WeakMap<LineFacts, { width: number; index: number; size: number }>();

/** Estimate the wrap width from the longest logical line near this break,
 *  walking at most `WIDTH_REACH` lines each way within its paragraph. */
function wrapWidth(buf: CopyBuffer, r: number): number {
  const above = line(buf, r);
  const below = line(buf, r + 1);
  const known = below.boundary ? undefined : paragraphWidth.get(above);
  // This break's own walks would read the whole paragraph too.
  if (known && known.index <= WIDTH_REACH && known.size - known.index - 2 <= WIDTH_REACH) return known.width;
  const up = paragraphLines(buf, above, -1);
  const down = paragraphLines(buf, below, 1);
  const width = Math.max(...[above, below, ...up, ...down].map((l) => l.plain.length));
  if (!above.boundary && !below.boundary && up.length < WIDTH_REACH && down.length < WIDTH_REACH) {
    const paragraph = [...up.reverse(), above, below, ...down];
    paragraph.forEach((l, index) => paragraphWidth.set(l, { width, index, size: paragraph.length }));
  }
  return width;
}

/** A paragraph whose longest row is narrower than this was never wrapped:
 *  40 columns, or 60% of a narrower terminal (rationale). */
const minWrapWidth = (buf: CopyBuffer) => Math.min(40, Math.floor(buf.cols * 0.6));

export type BreakKind = 'keep' | 'space' | 'none';

/** Auto judges the break between rows `r` and `r + 1` in order:
 * 1. Delete a true soft wrap before inspecting the joined logical lines.
 * 2. Keep blanks, a new list item, code punctuation (`; { }` / `) } ]`), or
 *    indentation that differs from the current line's hanging indent.
 * 3. Keep a break when the local longest line is under `minWrapWidth`, or
 *    when the next first word would have fit within that width.
 * 4. Delete a margin split whose last word is token-shaped; otherwise space.
 * `wrapWidth` reads at most `WIDTH_REACH` logical lines on each side within
 * the paragraph, not necessarily the whole paragraph. Its cache is reusable
 * only when that bounded walk would reach both paragraph boundaries.
 */
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
  /** A row a soft wrap continues, whose start is wherever the wrap fell;
   *  never in a block slab. */
  continues: boolean;
}
/** One logical line's rows in a scope: a row and the rows soft wraps join
 *  to it. */
type LineRows = readonly Line[];

/** The rows of `scope` from `buf`, grouped by logical line. */
function extract(buf: CopyBuffer, scope: Span, original: Span): Line[][] {
  const lines: Line[][] = [];
  for (let r = scope.start.row; r <= scope.end.row; r++) {
    const row = buf.row(r);
    const a = scope.block || r === scope.start.row ? scope.start.col : 0;
    const b = scope.block || r === scope.end.row ? scope.end.col + 1 : row.cells.length;
    const out: Cell[] = [];
    for (let c = a; c < Math.min(b, row.cells.length); c++) {
      if (row.cells[c] !== '') out.push({ ch: row.cells[c], added: !contains(original, r, c) });
    }
    const line = { ...splitTrail(out), row: r, startCol: a, continues: !scope.block && row.wrapped };
    if (line.continues && lines.length) lines[lines.length - 1].push(line);
    else lines.push([line]);
  }
  return lines;
}

/** `cells` as a line's text and the trailing blanks after it. */
function splitTrail(cells: Cell[]): Pick<Line, 'cells' | 'trail'> {
  let end = cells.length;
  while (end && /^\s*$/.test(cells[end - 1].ch)) end--;
  return { cells: cells.slice(0, end), trail: cells.slice(end) };
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

/** A logical line's rows with its decoration blanked, judged on the rows
 *  joined as a deleted soft wrap joins them, as `line` judges; null for a
 *  frame-only line. */
function stripDecoration(rows: LineRows): Line[] | null {
  // Every row but the last keeps the blanks the join puts back.
  const own = rows.map((l, k) => (k < rows.length - 1 ? [...l.cells, ...l.trail] : l.cells));
  const joined = own.flat();
  const text = joined.map((c) => c.ch).join('');
  if (isFrameOnly(text)) return null;
  const d = decoration(text);
  const from = cellsForChars(joined, d.blankFrom);
  const to = cellsForChars(joined, d.blankTo);
  const keepTo = cellsForChars(joined, d.keepTo);
  let kept = joined.slice(0, keepTo).map((c, j) => (j >= from && j < to ? { ...c, ch: ' ' } : c));
  const cut = keepTo < joined.length;
  // A cut ends the line at its last kept text, and drops the rows past it.
  if (cut) kept = splitTrail(kept).cells;
  const out: Line[] = [];
  let at = 0;
  for (const [k, l] of rows.entries()) {
    const first = at;
    at += own[k].length;
    if (cut && k > 0 && first >= kept.length) break;
    // A row the decoration misses stays as read.
    out.push(at <= kept.length && (first >= to || at <= from) ? l : { ...l, ...splitTrail(kept.slice(first, at)) });
  }
  return out;
}

/** A scope's rows, read once for every format: as displayed, and with
 *  decoration stripped, each grouped by logical line. */
export interface ScopeLines {
  buf: CopyBuffer;
  block: boolean;
  raw: readonly LineRows[];
  stripped: readonly LineRows[];
}

/** Read `scope`, marking every cell outside `original` (the dragged
 *  selection) as added. */
export function readScope(buf: CopyBuffer, scope: Span, original: Span): ScopeLines {
  const raw = extract(buf, scope, original);
  return { buf, block: scope.block, raw, stripped: raw.map(stripDecoration).filter((l): l is Line[] => l !== null) };
}

/** What a format shows of a scope before any per-break override: its lines,
 *  Auto's shared indent, and its own decision at each line's break. */
interface Layout {
  lines: readonly Line[];
  /** In absolute columns. */
  base: number;
  auto: readonly BreakKind[];
}

/** Each scope's layout per format, which every override render reuses. */
const layouts = new WeakMap<ScopeLines, Partial<Record<CopyFormat, Layout>>>();

function layout(scopeLines: ScopeLines, format: CopyFormat): Layout {
  let byFormat = layouts.get(scopeLines);
  if (!byFormat) layouts.set(scopeLines, (byFormat = {}));
  return (byFormat[format] ??= computeLayout(scopeLines, format));
}

function computeLayout({ buf, raw, stripped }: ScopeLines, format: CopyFormat): Layout {
  const logical = format === 'exact' ? raw : stripped;
  // A blank line is a logical line with no text in the scope: a blank row a
  // soft wrap joins to text is part of that text's line.
  const blanks = new Set(logical.filter((rows) => rows.every((l) => l.cells.length === 0)).flat());
  const blank = (l: Line) => blanks.has(l);
  let lines = logical.flat();
  if (format !== 'exact') {
    while (lines.length && blank(lines[0])) lines.shift();
    while (lines.length && blank(lines[lines.length - 1])) lines.pop();
    if (format === 'spaces' || format === 'joined') lines = lines.filter((l) => !blank(l));
    else lines = lines.filter((l, i) => !(blank(l) && i > 0 && blank(lines[i - 1])));
  }
  // A mid-row selection still uses its full row's indent, so the next line's
  // relative indent survives. Soft-wrap continuations have no indent of their own.
  const indents = lines.filter((l) => !blank(l) && !l.continues)
    .map((l) => Math.min(l.startCol + leading(l.cells), contentStart(buf, l.row)));
  const auto = lines.map((line, i): BreakKind => {
    const next = lines[i + 1];
    if (!next) return 'keep';
    // The row its line ends at, past any rows a cut decoration dropped.
    const end = next.continues ? line.row : buf.row(line.row).bottom;
    return FIXED_BREAK[format] ?? (blank(line) || blank(next) || next.row !== end + 1 ? 'keep' : autoBreak(buf, end));
  });
  return { lines, base: indents.length ? Math.min(...indents) : 0, auto };
}

export function renderLines(scopeLines: ScopeLines, chosen: CopyFormat, overrides: Readonly<Record<number, BreakKind>> = {}): Rendering {
  // Never rewrap a block slab (spec §4.1).
  const format = scopeLines.block && chosen === 'auto' ? 'exact' : chosen;
  const { lines, base, auto } = layout(scopeLines, format);
  const pieces: Piece[] = [];
  let text = '';
  let joined = false;
  /** The break before this line deleted a soft wrap, which joins exactly. */
  let rejoined = false;
  lines.forEach((line, i) => {
    const next = lines[i + 1];
    const kind = overrides[i] ?? auto[i];
    const rejoins = kind === 'none' && !!next?.continues;
    const lead = leading(line.cells);
    let strip: number;
    if (rejoined) strip = 0;
    else if (format === 'exact') strip = joined ? lead : 0;
    else if (joined || format !== 'auto') strip = lead;
    else strip = line.startCol > base || line.continues ? lead : Math.min(lead, base - line.startCol);
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
    pieces.push({ t: 'break', index: i, kind, auto: auto[i] });
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
  if (!line(buf, sr).boundary) while (sr > 0 && !line(buf, sr - 1).boundary) sr--;
  let er = sel.end.row;
  if (!line(buf, er).boundary) while (er + 1 < buf.length && !line(buf, er + 1).boundary) er++;
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
  col = Math.min(col, buf.row(row).cells.length) + dir;
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
  const leavingWord = (dir > 0) === (edge === 'start') && !isBlankCell(cellAt(buf, p));
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
