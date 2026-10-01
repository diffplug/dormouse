/**
 * Detect URL-shaped and path-shaped tokens around a cursor position.
 * Used by the smart-extension feature to offer "Press e to select the full
 * URL/path" during a mid-drag (spec §5).
 */
import type { IBuffer, IBufferCell } from '@xterm/xterm';
import { lineAt, textCells, wrapRun } from './buffer-cells';
import type { GridPos } from './copy-text';

export interface DetectedToken {
  kind: 'url' | 'path';
  /** Inclusive start column in the original line. */
  start: number;
  /** Exclusive end column in the original line. */
  end: number;
  text: string;
}

interface Pattern {
  kind: 'url' | 'path';
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  { kind: 'url', re: /^https?:\/\/\S+$/ },
  { kind: 'url', re: /^file:\/\/\S+$/ },
  { kind: 'path', re: /^\S+:\d+(:\d+)?$/ }, // error-location first (so it beats generic path)
  { kind: 'path', re: /^~\/\S*$/ },
  { kind: 'path', re: /^\/\S+$/ },
  { kind: 'path', re: /^\.\.?\/\S*$/ },
  { kind: 'path', re: /^[A-Za-z]:\\\S*$/ },
];

const TRAILING_PUNCT = /[.,;:!?'"]+$/;
const PAIRS: Array<[string, string]> = [['(', ')'], ['[', ']'], ['{', '}'], ['<', '>']];

function isBalanced(text: string, open: string, close: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function stripTrailing(token: string): string {
  let out = token;
  let changed = true;
  while (changed) {
    changed = false;
    const afterPunct = out.replace(TRAILING_PUNCT, '');
    if (afterPunct !== out) {
      out = afterPunct;
      changed = true;
    }
    for (const [open, close] of PAIRS) {
      if (out.endsWith(close) && !isBalanced(out, open, close)) {
        out = out.slice(0, -1);
        changed = true;
      }
    }
  }
  return out;
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * Return the token at or adjacent to `col` if it matches one of the known
 * URL/path patterns, or null otherwise. Trailing punctuation that is
 * unlikely to be part of the token is stripped per spec §5.1.
 */
export function detectTokenAt(line: string, col: number): DetectedToken | null {
  if (col < 0 || line.length === 0) return null;
  const probe = Math.min(col, line.length - 1);
  if (isWhitespace(line[probe])) return null;

  let start = probe;
  while (start > 0 && !isWhitespace(line[start - 1])) start--;
  let end = probe;
  while (end < line.length && !isWhitespace(line[end])) end++;

  const raw = line.slice(start, end);
  if (!raw) return null;

  // Strip trailing punctuation once, then test all patterns against the
  // cleaned token. This ensures error-location patterns like `file:42` are
  // found even when the original token had a trailing period (e.g. in
  // compiler output "Error at src/foo.ts:42.").
  const cleaned = stripTrailing(raw);
  if (!cleaned) return null;

  for (const { kind, re } of PATTERNS) {
    if (!re.test(cleaned)) continue;
    return { kind, start, end: start + cleaned.length, text: cleaned };
  }
  return null;
}

/** A token in the terminal buffer, by its first and last cells. */
export type BufferToken = Omit<DetectedToken, 'start' | 'end'> & { start: GridPos; end: GridPos };

/** How many rows a token is read across either side of the pointer's, which
 * bounds the work of each drag update. */
const WRAP_REACH = 16;

let scratch: IBufferCell | undefined;

/** The token at `col` of buffer row `row`, read across the soft wraps either
 * side of it: a soft wrap is not whitespace. Blank cells read nothing more.
 * Must re-read surrounding cells even at an unchanged pointer: terminal output
 * can change the token or its wrap boundaries without changing that cell. */
export function detectTokenInBuffer(buffer: IBuffer, row: number, col: number): BufferToken | null {
  const cell = lineAt(buffer, row)?.getCell(col, scratch);
  if (!cell) return null;
  scratch ??= cell;
  const chars = cell.getChars();
  // An empty cell, or the padding a wide character leaves when it wraps.
  if (cell.getWidth() !== 0 && (chars === '' || isWhitespace(chars[0]))) return null;
  return readToken(buffer, row, col);
}

/** One row as the detector reads it: its cells, their text, and the cell
 * each UTF-16 unit of the text sits in. */
interface RowText { row: number; cells: string[]; text: string; units: number[] }

const WHITESPACE = /[ \t\n\r]/;

/** {@link detectTokenInBuffer} past its early returns. Reads the pointer's
 * row, and the rows a soft wrap joins to it only while the run of
 * non-whitespace from the pointer reaches that edge. Converts the string
 * detector's UTF-16 offsets to xterm cells: wide characters have a zero-width
 * continuation cell, and combining marks and emoji can occupy several code
 * units within one cell. */
function readToken(buffer: IBuffer, row: number, col: number): BufferToken | null {
  const { top, lines } = wrapRun(buffer, row, WRAP_REACH);
  const read = (r: number): RowText => {
    const cells = textCells(lines[r - top], lines[r - top + 1]);
    let text = '';
    const units: number[] = [];
    cells.forEach((chars, c) => {
      text += chars;
      for (let i = 0; i < chars.length; i++) units.push(c);
    });
    return { row: r, cells, text, units };
  };
  const here = read(row);
  let start = col;
  while (start > 0 && here.cells[start] === '') start--;
  const probe = here.units.indexOf(start);
  if (probe < 0) return null;
  const rows = [here];
  /** The text read above the pointer's row. */
  let above = 0;
  // A soft wrap is not whitespace: a run reaching a row's edge goes on.
  if (!WHITESPACE.test(here.text.slice(0, probe))) {
    for (let r = row - 1; r >= top; r--) {
      rows.unshift(read(r));
      above += rows[0].text.length;
      if (WHITESPACE.test(rows[0].text)) break;
    }
  }
  if (!WHITESPACE.test(here.text.slice(probe))) {
    for (let r = row + 1; r < top + lines.length; r++) {
      rows.push(read(r));
      if (WHITESPACE.test(rows[rows.length - 1].text)) break;
    }
  }
  const token = detectTokenAt(rows.map((r) => r.text).join(''), above + probe);
  if (!token) return null;
  /** The row and cell UTF-16 unit `unit` of the joined text sits in. */
  const locate = (unit: number): { at: RowText; col: number } => {
    let at = rows[0];
    for (let k = 1; unit >= at.text.length; k++) {
      unit -= at.text.length;
      at = rows[k];
    }
    return { at, col: at.units[unit] };
  };
  const first = locate(token.start);
  const last = locate(token.end - 1);
  let end = last.col;
  while (last.at.cells[end + 1] === '') end++;
  return { ...token, start: { row: first.at.row, col: first.col }, end: { row: last.at.row, col: end } };
}
