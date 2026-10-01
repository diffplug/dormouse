/**
 * Detect URL-shaped and path-shaped tokens around a cursor position.
 * Used by the smart-extension feature to offer "Press e to select the full
 * URL/path" during a mid-drag (spec §5).
 */
import type { IBuffer } from '@xterm/xterm';
import { textCells, wrapRun } from './buffer-cells';

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

export interface BufferCell { row: number; col: number }

/** A token in the terminal buffer, by its first and last cells. */
export interface BufferToken {
  kind: 'url' | 'path';
  start: BufferCell;
  end: BufferCell;
  text: string;
}

/** How many rows a token is read across either side of the pointer's, which
 * bounds the work of each drag update. */
const WRAP_REACH = 16;

/** The token at `col` of buffer row `row`, read across the soft wraps either
 * side of it: a soft wrap is not whitespace. Convert the string detector's
 * UTF-16 offsets to xterm cells. Wide characters have a zero-width
 * continuation cell; combining marks and emoji can occupy several code units
 * within one cell. */
export function detectTokenInBuffer(buffer: IBuffer, row: number, col: number): BufferToken | null {
  const { top, lines } = wrapRun(buffer, row, WRAP_REACH);
  let text = '';
  let probe = -1;
  const starts: BufferCell[] = [];
  const ends: BufferCell[] = [];
  for (const [k, line] of lines.entries()) {
    const r = top + k;
    const cells = textCells(line, lines[k + 1]);
    for (let c = 0; c < cells.length; c++) {
      const chars = cells[c];
      if (chars === '') continue;
      let width = 1;
      while (cells[c + width] === '') width++;
      if (r === row && c <= col && col < c + width) probe = text.length;
      for (let i = 0; i < chars.length; i++) {
        starts.push({ row: r, col: c });
        ends.push({ row: r, col: c + width - 1 });
      }
      text += chars;
    }
  }
  const token = detectTokenAt(text, probe);
  return token ? { kind: token.kind, start: starts[token.start], end: ends[token.end - 1], text: token.text } : null;
}
