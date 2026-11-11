/**
 * What the full-screen fuzzy pickers share — `dor open`'s file picker and
 * `dor tool`'s Tool picker: the alternate-screen session, raw key decoding, a
 * frame painter that rewrites only changed rows, the query and selection over
 * a `Ranker`, and text measured in terminal columns.
 */
import type { PickerTerminal } from './types.js';
import type { Ranker } from './fuzzy.js';
import { printable, stripControls } from './terminal-text.js';

const ESC = '\x1b';
const CSI = `${ESC}[`;
export const SGR = {
  reset: `${CSI}0m`, bold: `${CSI}1m`, dim: `${CSI}2m`,
  match: `${CSI}1;36m`, accent: `${CSI}1;33m`,
};
export const dim = (text: string) => `${SGR.dim}${text}${SGR.reset}`;
const ENTER_SCREEN = `${CSI}?1049h${CSI}?1000h${CSI}?1006h${CSI}?2004h`;
const LEAVE_SCREEN = `${CSI}?2004l${CSI}?1006l${CSI}?1000l${CSI}?25h${CSI}?1049l`;
const DOUBLE_CLICK_MS = 400;
/** Wide enough for a list and a detail panel beside it. */
const PANEL_MIN_COLUMNS = 100;

/** Whether a terminal `columns` wide shows a panel beside the list. */
export const hasPanel = (columns: number) => columns >= PANEL_MIN_COLUMNS;
/** Columns the list takes: all of them, or its share beside a panel. */
export const listWidth = (columns: number) => (hasPanel(columns) ? Math.floor(columns * 0.55) : columns);
/** A list row and the panel line beside it, which is `columns - width - 3` wide. */
export const besidePanel = (line: string, width: number, side: string) => `${padTo(line, width)} ${dim('│')} ${side}`;

/** A narrow terminal's status line: `head` bold, then `rest` dim, both clipped. */
export function statusLine(head: string, rest: string, columns: number): string {
  return `${SGR.bold}${clip(head, columns)}${SGR.reset}${dim(clip(rest, columns - displayWidth(head)))}`;
}

export interface PickerScreen {
  /** Draws `lines` from the top row, then puts the cursor on the query row at
   *  `cursorColumn` (1-based). */
  paint(lines: readonly string[], columns: number, rows: number, cursorColumn: number): void;
  /** Stops input and leaves the alternate screen. */
  close(): void;
}

/** Takes the terminal over: the alternate screen, mouse and paste reporting,
 *  and raw input as picker keys, until `close`. */
export function openPickerScreen(terminal: PickerTerminal, onKeys: (keys: Key[]) => void, onResize: () => void): PickerScreen {
  let previousLines: readonly string[] = [];
  let previousSize = '';
  terminal.write(ENTER_SCREEN);
  const stop = terminal.listen(chunk => onKeys(parseKeys(chunk)), onResize);
  return {
    paint(lines, columns, rows, cursorColumn) {
      // Frames that change nothing visible stay silent, and real updates leave
      // unchanged rows alone. A resize invalidates the cache because the
      // terminal may reflow rows. Erasing before writing keeps a character in
      // the last column, where an erase after it would land on that character.
      const size = `${columns}x${rows}`;
      let out = '';
      lines.forEach((line, index) => {
        if (size === previousSize && line === previousLines[index]) return;
        out += `${CSI}${index + 1};1H${CSI}2K${line}${SGR.reset}`;
      });
      previousLines = lines;
      previousSize = size;
      if (out) terminal.write(`${CSI}?2026h${CSI}?25l${out}${CSI}1;${cursorColumn}H${CSI}?25h${CSI}?2026l`);
    },
    close() {
      stop();
      terminal.write(LEAVE_SCREEN);
    },
  };
}

/**
 * The query and the selection over a `Ranker`, as both pickers edit them: the
 * selection is held by item, so a resize or arriving results never move it.
 */
export class PickerList {
  query = '';
  /** The first listed item on screen. */
  scroll = 0;
  /** List rows in the last frame, from screen row 1. */
  rows = 0;
  private lastClick = { row: -1, at: 0 };

  constructor(private readonly ranker: Ranker) {}

  /** Applies a query or navigation key; false for a key the picker acts on itself. */
  key(key: Key): boolean {
    switch (key.kind) {
      case 'text': this.setQuery(this.query + key.text); return true;
      case 'backspace': this.setQuery(Array.from(this.query).slice(0, -1).join('')); return true;
      case 'clear': this.setQuery(''); return true;
      case 'word': this.setQuery(this.query.replace(/\S*\s*$/, '')); return true;
      case 'up': this.move(-1); return true;
      case 'down': this.move(1); return true;
      case 'pageUp': this.move(-Math.max(1, this.rows - 1)); return true;
      case 'pageDown': this.move(Math.max(1, this.rows - 1)); return true;
      case 'home': this.move(-this.ranker.count); return true;
      case 'end': this.move(this.ranker.count); return true;
      default: return false;
    }
  }

  private move(delta: number): void {
    const { ranker } = this;
    if (ranker.count > 0) ranker.select(Math.max(0, Math.min(ranker.count - 1, ranker.cursor + delta)));
  }

  /** Selects what a click on list `row` lands on; true when it is a second
   *  click on the selected item, the double-click that accepts it. */
  click(row: number): boolean {
    const index = this.scroll + row - 1;
    if (row < 1 || row > this.rows || index >= this.ranker.count) return false;
    const now = Date.now();
    const repeat = this.lastClick.row === row && now - this.lastClick.at < DOUBLE_CLICK_MS && index === this.ranker.cursor;
    this.lastClick = { row, at: now };
    this.ranker.select(index);
    return repeat;
  }

  /** Lays the list out in `rows` rows, scrolled to keep the selection on
   *  screen; the selection's position. */
  layout(rows: number): number {
    this.rows = rows;
    const cursor = this.ranker.cursor;
    if (cursor < this.scroll) this.scroll = cursor;
    if (cursor >= this.scroll + rows) this.scroll = cursor - rows + 1;
    return cursor;
  }

  /** The query row: the prompt and query, the count right-aligned. */
  queryRow(columns: number, count: string): { line: string; cursorColumn: number } {
    const shown = clip(printable(this.query), columns - 4 - count.length);
    return {
      line: padTo(`${SGR.accent}>${SGR.reset} ${shown}`, columns - count.length) + dim(count),
      cursorColumn: 3 + displayWidth(shown),
    };
  }

  private setQuery(next: string): void {
    if (next === this.query) return;
    this.query = next;
    this.ranker.setQuery(next);
  }
}

/** Keys as the pickers act on them: a paste is text, a wheel notch an arrow. */
export type Key =
  | { kind: 'text'; text: string }
  | { kind: 'click'; row: number; column: number }
  | { kind: 'backspace' | 'clear' | 'word' | 'up' | 'down' | 'pageUp' | 'pageDown' | 'home' | 'end'
      | 'nextHandler' | 'previousHandler' | 'enter' | 'cancel' };

const CSI_KEYS: Record<string, Key['kind']> = {
  A: 'up', B: 'down', C: 'nextHandler', D: 'previousHandler', Z: 'previousHandler', H: 'home', F: 'end',
  '5~': 'pageUp', '6~': 'pageDown', '1~': 'home', '4~': 'end', '7~': 'home', '8~': 'end',
};
const CONTROL_KEYS: Record<string, Key['kind']> = {
  '\r': 'enter', '\n': 'enter', '\t': 'nextHandler', '\x7f': 'backspace', '\b': 'backspace',
  '\x03': 'cancel', '\x07': 'cancel', '\x04': 'cancel', '\x15': 'clear', '\x17': 'word',
  '\x10': 'up', '\x0e': 'down', '\x0b': 'up',
};
const PASTE_START = `${CSI}200~`;
const PASTE_END = `${CSI}201~`;

/** Raw terminal input, one chunk at a time, as picker keys. A lone ESC ending
 *  a chunk is Escape; unknown sequences are dropped. Rows and columns of a
 *  click are 0-based. */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk.startsWith(PASTE_START, i)) {
      const end = chunk.indexOf(PASTE_END, i);
      const stop = end < 0 ? chunk.length : end;
      keys.push({ kind: 'text', text: stripControls(chunk.slice(i + PASTE_START.length, stop).replace(/[\r\n\t]+/g, ' ')) });
      i = end < 0 ? chunk.length : end + PASTE_END.length;
      continue;
    }
    const char = chunk[i];
    if (char === ESC) {
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(chunk.slice(i));
      if (mouse) {
        const [whole, button, column, row, kind] = mouse;
        const code = Number(button);
        if (code === 64) keys.push({ kind: 'up' });
        else if (code === 65) keys.push({ kind: 'down' });
        else if (code === 0 && kind === 'M') keys.push({ kind: 'click', row: Number(row) - 1, column: Number(column) - 1 });
        i += whole.length;
        continue;
      }
      const sequence = /^\x1b(?:\[([0-9;]*)([A-Za-z~])|O([A-Za-z]))/.exec(chunk.slice(i));
      if (sequence) {
        const final = sequence[3] ?? (sequence[2] === '~' ? `${sequence[1].split(';')[0]}~` : sequence[2]);
        const kind = CSI_KEYS[final];
        if (kind) keys.push({ kind } as Key);
        i += sequence[0].length;
        continue;
      }
      if (i === chunk.length - 1) keys.push({ kind: 'cancel' });
      // Alt+key: drop the ESC and its key.
      i += 2;
      continue;
    }
    const control = CONTROL_KEYS[char];
    if (control) { keys.push({ kind: control } as Key); i++; continue; }
    const codePoint = chunk.codePointAt(i)!;
    const text = String.fromCodePoint(codePoint);
    if (stripControls(text) === text) {
      const last = keys[keys.length - 1];
      if (last?.kind === 'text') last.text += text;
      else keys.push({ kind: 'text', text });
    }
    i += text.length;
  }
  return keys;
}

/** One drawn character of a list row. */
export interface Cell { text: string; style: string; width: number }

/** `text` as cells, each character passed through `escape` and styled by
 *  `styleAt` with its UTF-16 index, as match positions count. */
export function textCells(text: string, styleAt: (index: number) => string, escape: (char: string) => string = printable): Cell[] {
  const cells: Cell[] = [];
  let index = 0;
  for (const char of text) {
    const shown = escape(char);
    cells.push({ text: shown, style: styleAt(index), width: displayWidth(shown) });
    index += char.length;
  }
  return cells;
}

const cellsWidth = (cells: readonly Cell[]) => cells.reduce((sum, cell) => sum + cell.width, 0);

/** `cells` cut to `width` columns, losing their `cut` end to a `…`. */
export function fitCells(cells: readonly Cell[], width: number, cut: 'start' | 'end'): Cell[] {
  let total = cellsWidth(cells);
  if (total <= width) return [...cells];
  const ellipsis: Cell = { text: '…', style: SGR.dim, width: 1 };
  if (cut === 'start') {
    const kept = [...cells];
    while (kept.length > 0 && total > width - 1) total -= kept.shift()!.width;
    return [ellipsis, ...kept];
  }
  const kept: Cell[] = [];
  let used = 0;
  for (const cell of cells) {
    if (used + cell.width > width - 1) break;
    kept.push(cell);
    used += cell.width;
  }
  return [...kept, ellipsis];
}

/** A list row: the pointer when selected, then the cells, bold when selected. */
export function renderRow(cells: readonly Cell[], selected: boolean): string {
  const pointer = selected ? `${SGR.accent}›${SGR.reset} ` : '  ';
  let body = '';
  let style: string | undefined;
  for (const cell of cells) {
    if (cell.style !== style) body += `${SGR.reset}${selected ? SGR.bold : ''}${(style = cell.style)}`;
    body += cell.text;
  }
  return `${pointer}${body}${SGR.reset}`;
}

/** `path` with `home` spelled `~`. */
export function shortPath(path: string, home: string | undefined): string {
  return home && (path === home || path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) ? `~${path.slice(home.length)}` : path;
}

/** Columns a code point occupies: 0 for combining marks and joiners, 2 for
 *  East Asian wide and emoji, else 1. */
function charWidth(char: string): number {
  const code = char.codePointAt(0)!;
  if (/\p{M}|‍|[︀-️]/u.test(char)) return 0;
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd)) return 2;
  return 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripSgr(text)) width += charWidth(char);
  return width;
}

function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Plain text cut to `width` columns, ending in `…` when cut. */
export function clip(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  let out = '';
  let used = 0;
  for (const char of text) {
    const next = charWidth(char);
    if (used + next > width - 1) break;
    out += char;
    used += next;
  }
  return `${out}…`;
}

/** Styled text padded with spaces to `width` columns. */
export function padTo(text: string, width: number): string {
  return text + SGR.reset + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** Hints packed whole onto lines of at most `width` columns. */
export function packHints(hints: readonly string[], width: number): string[] {
  const lines: string[] = [];
  for (const hint of hints) {
    const last = lines[lines.length - 1];
    if (last !== undefined && displayWidth(`${last}  ${hint}`) <= width) lines[lines.length - 1] = `${last}  ${hint}`;
    else lines.push(clip(hint, width));
  }
  return lines;
}

/** Plain text broken at spaces into lines of at most `width` columns. */
export function wrap(text: string, width: number): string[] {
  if (width <= 1) return [];
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line ? `${line} ${word}` : word;
    if (displayWidth(candidate) <= width) { line = candidate; continue; }
    if (line) lines.push(line);
    line = displayWidth(word) <= width ? word : clip(word, width);
  }
  if (line) lines.push(line);
  return lines;
}
