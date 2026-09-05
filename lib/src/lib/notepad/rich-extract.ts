// Capturing a terminal selection as styled runs (docs/specs/notepad.md).
// Deliberately *not* Copy Rewrapped: soft-wrapped rows rejoin, every hard break
// survives, and nothing is stripped — a captured excerpt has to read like what
// was on the screen. Only the four attributes `RichTextRun` carries survive;
// xterm exposes more, but underline/dim/blink/strike/hyperlinks have no place
// in a note the user can edit into plain text.
import type { Terminal } from '@xterm/xterm';
import { parseColor, toHex } from '../css-color';
import type { Selection } from '../mouse-selection';
import { extractSelectionText, normalizeSelection } from '../selection-text';
import { getTerminalTheme } from '../terminal-theme';
import type { RichTextRun } from './types';

/** Minimal slice of an xterm.js `IBufferCell`, kept tiny so this is unit-testable. */
export interface CellLike {
  getChars(): string;
  getWidth(): number;
  isBold(): number;
  isItalic(): number;
  isInverse(): number;
  isFgDefault(): boolean;
  isFgPalette(): boolean;
  isFgRGB(): boolean;
  getFgColor(): number;
  isBgDefault(): boolean;
  isBgPalette(): boolean;
  isBgRGB(): boolean;
  getBgColor(): number;
}

/** Minimal slice of an xterm.js `IBufferLine`. */
export interface LineLike {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(x: number): CellLike | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

/** Minimal slice of an xterm.js `IBuffer`. */
export interface BufferLike {
  getLine(y: number): LineLike | undefined;
}

/** Minimal slice of an xterm.js `Terminal`. A real `Terminal` satisfies it
 *  structurally, so the live wrapper below passes one straight through. */
export interface TerminalLike {
  readonly cols: number;
  readonly buffer: { readonly active: BufferLike };
}

/** ANSI palette entries 0–15 in index order, named as `getTerminalTheme()` names them. */
const ANSI_NAMES = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

export type AnsiColorName = (typeof ANSI_NAMES)[number];

/**
 * The colors a capture needs from the live theme: the 16 ANSI entries plus the
 * two defaults an inverse cell swaps in. Values are whatever CSS the host's
 * tokens hold — `rgb()`, `#rgb`, or a hex with alpha — and are normalized here,
 * so a capture never carries a color string a renderer cannot read.
 */
export type TerminalPalette = Record<AnsiColorName | 'foreground' | 'background', string>;

const PALETTE_KEYS: readonly (keyof TerminalPalette)[] = ['foreground', 'background', ...ANSI_NAMES];

export interface RichExtractOptions {
  /** Mirrors `terminal.options.drawBoldTextInBrightColors`; xterm defaults it to true. */
  drawBoldTextInBrightColors?: boolean;
}

export interface RichCapture {
  runs: RichTextRun[];
  /** `extractSelectionText` over the same selection — the source-pin validation
   *  key, so it is read from the buffer rather than rebuilt from `runs`. */
  rawText: string;
}

/** Project the live terminal theme onto the palette this module consumes. */
function currentTerminalPalette(): TerminalPalette {
  const theme = getTerminalTheme();
  const palette: Record<string, string> = {};
  for (const key of PALETTE_KEYS) palette[key] = theme[key] ?? '';
  return palette as TerminalPalette;
}

/** Normalize a theme color to lowercase `#rrggbb`; alpha is dropped, and an
 *  unparseable token becomes "no color" so the note falls back to the default. */
function normalizeHex(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const rgba = parseColor(value);
  return rgba ? toHex(rgba) : undefined;
}

/** The packed 0xRRGGBB an RGB-mode cell reports. */
function unpackRgb(packed: number): string {
  return toHex({ r: (packed >> 16) & 0xff, g: (packed >> 8) & 0xff, b: packed & 0xff, a: 1 });
}

/** xterm's 256-color table above the themed 16: a 6×6×6 cube at 16–231 and a
 *  24-step gray ramp at 232–255. Computed, because the table is a formula. */
function xterm256(index: number): string {
  if (index >= 232) {
    const level = (index - 232) * 10 + 8;
    return toHex({ r: level, g: level, b: level, a: 1 });
  }
  const offset = index - 16;
  const channel = (n: number) => (n === 0 ? 0 : 55 + n * 40);
  return toHex({
    r: channel(Math.floor(offset / 36)),
    g: channel(Math.floor(offset / 6) % 6),
    b: channel(offset % 6),
    a: 1,
  });
}

function paletteHex(index: number, theme: TerminalPalette): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  // 0–15 are the user's theme, not fixed values — a capture stays recognizable
  // next to the terminal it came from.
  return index < 16 ? normalizeHex(theme[ANSI_NAMES[index]]) : xterm256(index);
}

/** The subset of `RichTextRun` that is styling; `text` is carried separately. */
type CellStyle = Omit<RichTextRun, 'text'>;

function styleOf(cell: CellLike, theme: TerminalPalette, boldIsBright: boolean): CellStyle {
  const bold = cell.isBold() !== 0;
  const italic = cell.isItalic() !== 0;

  let fg: string | undefined;
  if (!cell.isFgDefault()) {
    if (cell.isFgRGB()) {
      fg = unpackRgb(cell.getFgColor());
    } else if (cell.isFgPalette()) {
      let index = cell.getFgColor();
      // xterm draws bold text from the bright half of the low palette while
      // `drawBoldTextInBrightColors` is on, and a note records what was drawn.
      if (bold && boldIsBright && index < 8) index += 8;
      fg = paletteHex(index, theme);
    }
  }

  let bg: string | undefined;
  if (!cell.isBgDefault()) {
    if (cell.isBgRGB()) bg = unpackRgb(cell.getBgColor());
    else if (cell.isBgPalette()) bg = paletteHex(cell.getBgColor(), theme);
  }

  if (cell.isInverse() !== 0) {
    // The swap has to make a defaulted side explicit, or inverting a cell that
    // relied on the defaults would read back as ordinary unstyled text.
    const swappedFg = bg ?? normalizeHex(theme.background);
    const swappedBg = fg ?? normalizeHex(theme.foreground);
    fg = swappedFg;
    bg = swappedBg;
  }

  const style: CellStyle = {};
  if (bold) style.bold = true;
  if (italic) style.italic = true;
  if (fg) style.foreground = fg;
  if (bg) style.background = bg;
  return style;
}

interface Piece {
  text: string;
  style: CellStyle;
}

function readRow(
  line: LineLike,
  c0: number,
  c1: number,
  theme: TerminalPalette,
  boldIsBright: boolean,
): Piece[] {
  const pieces: Piece[] = [];
  const end = Math.min(c1, line.length);
  for (let x = Math.max(0, c0); x < end; x += 1) {
    const cell = line.getCell(x);
    if (!cell) break;
    // Width 0 is the trailing half of a wide character, already emitted whole
    // by its width-2 cell.
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars();
    // An unwritten cell inside the range is a space, matching how
    // `translateToString` renders it.
    pieces.push({ text: chars === '' ? ' ' : chars, style: styleOf(cell, theme, boldIsBright) });
  }
  return pieces;
}

/** Drop trailing whitespace exactly as `extractSelectionText`'s `/\s+$/` does,
 *  keeping the styling of whatever survives. */
function trimTrailing(pieces: Piece[]): Piece[] {
  const text = pieces.map((p) => p.text).join('');
  const trimmed = text.replace(/\s+$/, '');
  if (trimmed.length === text.length) return pieces;
  const out: Piece[] = [];
  let kept = 0;
  for (const piece of pieces) {
    const room = trimmed.length - kept;
    if (room <= 0) break;
    out.push(room >= piece.text.length ? piece : { ...piece, text: piece.text.slice(0, room) });
    kept += piece.text.length;
  }
  return out;
}

function sameStyle(a: CellStyle, b: CellStyle): boolean {
  return a.bold === b.bold
    && a.italic === b.italic
    && a.foreground === b.foreground
    && a.background === b.background;
}

/**
 * Walk the cells under `sel` and return them as merged style runs plus the raw
 * selected text. Rows join with nothing when the row that follows is a soft
 * wrap (xterm's `isWrapped`) and with `\n` otherwise; block shapes are
 * rectangular slabs, so every one of their rows ends hard. Trailing whitespace
 * is trimmed only on a row that ends hard — a soft-wrapped row is full by
 * definition, and its trailing spaces are content.
 */
export function extractRichRuns(
  terminal: TerminalLike,
  sel: Selection,
  theme: TerminalPalette,
  options: RichExtractOptions = {},
): RichCapture {
  const boldIsBright = options.drawBoldTextInBrightColors ?? true;
  const n = normalizeSelection(sel);
  const buf = terminal.buffer.active;
  const block = sel.shape === 'block';

  const rows: Array<{ index: number; pieces: Piece[] }> = [];
  for (let r = n.r0; r <= n.r1; r += 1) {
    const line = buf.getLine(r);
    // `extractSelectionText` drops a missing row without a separator; stay in
    // step with it so the two views of one selection cannot disagree.
    if (!line) continue;
    const c0 = block || r === n.r0 ? n.c0 : 0;
    const c1 = block || r === n.r1 ? n.c1 + 1 : terminal.cols;
    rows.push({ index: r, pieces: readRow(line, c0, c1, theme, boldIsBright) });
  }

  const pieces: Piece[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const next = rows[i + 1];
    const soft = !block && next !== undefined && buf.getLine(next.index)?.isWrapped === true;
    pieces.push(...(soft ? rows[i].pieces : trimTrailing(rows[i].pieces)));
    // The break itself carries no styling: a colored newline is a rendering
    // artifact, not content.
    if (next && !soft) pieces.push({ text: '\n', style: {} });
  }

  const runs: RichTextRun[] = [];
  for (const piece of pieces) {
    if (!piece.text) continue;
    const last = runs[runs.length - 1];
    if (last && sameStyle(last, piece.style)) {
      last.text += piece.text;
      continue;
    }
    runs.push({ text: piece.text, ...piece.style });
  }

  return {
    runs,
    // Read from the buffer rather than rebuilt from `runs`: a source pin
    // resolves by comparing this byte for byte with a later read of the same
    // range, and the run text joins rows differently.
    rawText: extractSelectionText(terminal as Terminal, sel),
  };
}

/** `extractRichRuns` against the live theme and the terminal's own bold/bright setting. */
export function captureRichSelection(terminal: Terminal, sel: Selection): RichCapture {
  return extractRichRuns(terminal, sel, currentTerminalPalette(), {
    drawBoldTextInBrightColors: terminal.options.drawBoldTextInBrightColors,
  });
}
