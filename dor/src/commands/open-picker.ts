/**
 * `dor open` with no path: a full-screen fuzzy file picker that shows which
 * handler each file opens with and why, and lets the person choose another
 * (`docs/specs/dor-tool.md` -> Choosing a file).
 */
import type { OpenHandlersResponse, PickerTerminal } from './types.js';
import type { FileList } from './file-list.js';
import { rankMatches } from './fuzzy.js';
import { printable } from './shared.js';

export interface PickerChoice {
  /** Relative to the listing directory, `/`-separated. */
  file: string;
  /** The chosen handler; absent for the default `dor open` selects. */
  tool?: string;
}

export interface PickerOptions {
  terminal: PickerTerminal;
  files: Promise<FileList>;
  /** What could open a file; rejects when the host cannot say. */
  handlers(file: string): Promise<OpenHandlersResponse>;
  /** `--tool` fixed the handler. */
  fixedTool?: string;
  /** Shortens the config path shown under the handlers. */
  home?: string;
}

type HandlerState =
  | { status: 'loading' }
  | { status: 'ok'; response: OpenHandlersResponse }
  | { status: 'error'; message: string };

interface Result { item: string; positions: number[] }

/** Wide enough for a list and a handler panel beside it. */
export const PANEL_MIN_COLUMNS = 100;
const HANDLER_DEBOUNCE_MS = 30;
const DOUBLE_CLICK_MS = 400;

const ESC = '\x1b';
const CSI = `${ESC}[`;
const SGR = {
  reset: `${CSI}0m`, bold: `${CSI}1m`, dim: `${CSI}2m`,
  match: `${CSI}1;36m`, accent: `${CSI}1;33m`,
};
const ENTER_SCREEN = `${CSI}?1049h${CSI}?1000h${CSI}?1006h${CSI}?2004h`;
const LEAVE_SCREEN = `${CSI}?2004l${CSI}?1006l${CSI}?1000l${CSI}?25h${CSI}?1049l`;

export function runFilePicker(options: PickerOptions): Promise<PickerChoice | null> {
  const { terminal } = options;
  let all: string[] | null = null;
  let truncated = false;
  let query = '';
  let results: Result[] = [];
  /** The items matching `poolQuery`, in listing order: a longer query only narrows it. */
  let pool: string[] = [];
  let poolQuery = '';
  let cursor = 0;
  let scroll = 0;
  let handlerIndex = 0;
  let handlerFile: string | null = null;
  const handlerCache = new Map<string, HandlerState>();
  let handlerTimer: ReturnType<typeof setTimeout> | undefined;
  let lastClick = { row: -1, at: 0 };
  /** Screen rows (0-based) that select a handler when clicked. */
  let handlerRows = new Map<number, number>();
  let listRows = 0;

  return new Promise((resolve) => {
    let done = false;
    const finish = (choice: PickerChoice | null) => {
      if (done) return;
      done = true;
      clearTimeout(handlerTimer);
      stop();
      terminal.write(LEAVE_SCREEN);
      resolve(choice);
    };

    const current = (): string | undefined => results[cursor]?.item;
    const handlerState = (): HandlerState | undefined => {
      const file = current();
      return file === undefined ? undefined : handlerCache.get(file);
    };
    const handlerList = () => {
      const state = handlerState();
      return state?.status === 'ok' ? state.response.handlers : [];
    };

    const refilter = () => {
      if (!all) return;
      const narrows = poolQuery.trim() !== '' && query.startsWith(poolQuery);
      ({ results, matched: pool } = rankMatches(query, narrows ? pool : all));
      poolQuery = query;
      cursor = 0;
      scroll = 0;
    };

    const requestHandlers = () => {
      clearTimeout(handlerTimer);
      const file = current();
      if (file !== handlerFile) {
        handlerFile = file ?? null;
        handlerIndex = 0;
      }
      if (options.fixedTool !== undefined || file === undefined || handlerCache.has(file)) return;
      handlerTimer = setTimeout(() => {
        handlerCache.set(file, { status: 'loading' });
        render();
        options.handlers(file).then(
          response => handlerCache.set(file, { status: 'ok', response }),
          error => handlerCache.set(file, { status: 'error', message: error instanceof Error ? error.message : String(error) }),
        ).finally(() => { if (!done) render(); });
      }, HANDLER_DEBOUNCE_MS);
    };

    const move = (delta: number) => {
      if (results.length === 0) return;
      cursor = Math.max(0, Math.min(results.length - 1, cursor + delta));
      if (cursor < scroll) scroll = cursor;
      if (cursor >= scroll + listRows) scroll = cursor - listRows + 1;
      requestHandlers();
    };

    const cycleHandler = (delta: number) => {
      const count = handlerList().length;
      if (count > 1) handlerIndex = (handlerIndex + delta + count) % count;
    };

    const accept = () => {
      const file = current();
      if (file === undefined) return;
      const handlers = handlerList();
      finish(handlerIndex > 0 && handlers[handlerIndex] ? { file, tool: handlers[handlerIndex].tool } : { file });
    };

    const setQuery = (next: string) => {
      if (next === query) return;
      query = next;
      refilter();
      requestHandlers();
    };

    const click = (row: number, column: number) => {
      const handler = handlerRows.get(row);
      if (handler !== undefined && (column >= panelColumn() || row >= 1 + listRows)) {
        if (handler < 0) cycleHandler(1);
        else handlerIndex = handler;
        return;
      }
      if (row < 1 || row > listRows || column >= listWidth()) return;
      const index = scroll + row - 1;
      if (index >= results.length) return;
      const now = Date.now();
      const repeat = lastClick.row === row && now - lastClick.at < DOUBLE_CLICK_MS && index === cursor;
      lastClick = { row, at: now };
      move(index - cursor);
      if (repeat) accept();
    };

    const onInput = (chunk: string) => {
      for (const key of parseKeys(chunk)) {
        if (done) return;
        switch (key.kind) {
          case 'text': case 'paste': setQuery(query + key.text); break;
          case 'backspace': setQuery(Array.from(query).slice(0, -1).join('')); break;
          case 'clear': setQuery(''); break;
          case 'word': setQuery(query.replace(/\S*\s*$/, '')); break;
          case 'up': move(-1); break;
          case 'down': move(1); break;
          case 'pageUp': move(-Math.max(1, listRows - 1)); break;
          case 'pageDown': move(Math.max(1, listRows - 1)); break;
          case 'home': move(-cursor); break;
          case 'end': move(results.length); break;
          case 'nextHandler': cycleHandler(1); break;
          case 'previousHandler': cycleHandler(-1); break;
          case 'enter': accept(); break;
          case 'cancel': finish(null); return;
          case 'wheelUp': move(-1); break;
          case 'wheelDown': move(1); break;
          case 'click': click(key.row, key.column); break;
        }
      }
      if (!done) render();
    };

    const wide = () => terminal.columns() >= PANEL_MIN_COLUMNS;
    const listWidth = () => (wide() ? Math.floor(terminal.columns() * 0.55) : terminal.columns());
    const panelColumn = () => listWidth() + 2;

    const render = () => {
      const columns = Math.max(20, terminal.columns());
      const rows = Math.max(4, terminal.rows());
      const panel = wide();
      // Narrow terminals give the handler one status line above the hints.
      listRows = rows - 1 - (panel ? 1 : 2);
      if (cursor >= scroll + listRows) scroll = cursor - listRows + 1;
      const width = listWidth();
      const lines: string[] = [];

      const count = all ? `${results.length}/${all.length}${truncated ? '+' : ''}` : '';
      const prompt = `${SGR.accent}>${SGR.reset} ${clip(printable(query), columns - 4 - count.length)}`;
      lines.push(padTo(prompt, columns - count.length) + `${SGR.dim}${count}${SGR.reset}`);

      const panelLines = panel ? renderPanel(columns - width - 3) : [];
      for (let row = 0; row < listRows; row++) {
        let line: string;
        if (!all) line = row === 0 ? `${SGR.dim}  Listing files…${SGR.reset}` : '';
        else if (all.length === 0 && row === 0) line = `${SGR.dim}  No files here${SGR.reset}`;
        else {
          const result = results[scroll + row];
          line = result ? renderItem(result, scroll + row === cursor, width) : '';
        }
        if (panel) line = padTo(line, width) + ` ${SGR.dim}│${SGR.reset} ` + (panelLines[row] ?? '');
        lines.push(line);
      }
      // Panel line i is screen row i + 1, below the prompt.
      handlerRows = new Map(panel ? [...panelHandlerRows].map(([line, handler]) => [line + 1, handler]) : []);
      if (!panel) {
        lines.push(renderStatus(columns));
        if (handlerList().length > 1) handlerRows.set(rows - 2, -1);
      }
      lines.push(renderHints(columns));

      let out = `${CSI}?2026h${CSI}?25l`;
      lines.forEach((line, index) => { out += `${CSI}${index + 1};1H${line}${SGR.reset}${CSI}K`; });
      const promptWidth = 2 + Math.min(displayWidth(printable(query)), columns - 4 - count.length);
      out += `${CSI}1;${promptWidth + 1}H${CSI}?25h${CSI}?2026l`;
      terminal.write(out);
    };

    let panelHandlerRows = new Map<number, number>();
    const renderPanel = (width: number): string[] => {
      panelHandlerRows = new Map();
      const lines: string[] = [`${SGR.bold}Opens with${SGR.reset}`];
      const file = current();
      if (options.fixedTool !== undefined) {
        lines.push(`${SGR.accent}›${SGR.reset} ${SGR.bold}${clip(printable(options.fixedTool), width - 2)}${SGR.reset}`, `${SGR.dim}    chosen by --tool${SGR.reset}`);
        return lines;
      }
      if (file === undefined) return lines;
      const state = handlerCache.get(file);
      if (!state || state.status === 'loading') return [...lines, `${SGR.dim}  …${SGR.reset}`];
      if (state.status === 'error') {
        return [...lines, ...wrap(`Unknown: ${printable(state.message)}`, width).map(line => `${SGR.dim}${line}${SGR.reset}`),
          '', ...wrap('Enter opens it as dor open would.', width).map(line => `${SGR.dim}${line}${SGR.reset}`)];
      }
      const { handlers, config } = state.response;
      if (handlers.length === 0) {
        return [...lines, ...wrap(`Nothing opens this file. Add an open rule to ${shortPath(config, options.home)}.`, width)];
      }
      handlers.forEach((handler, index) => {
        const chosen = index === handlerIndex;
        const marker = chosen ? `${SGR.accent}›${SGR.reset} ` : '  ';
        const name = clip(printable(handler.tool), width - 4 - (index === 0 ? 10 : 0));
        panelHandlerRows.set(lines.length, index);
        lines.push(`${marker}${chosen ? SGR.bold : ''}${name}${SGR.reset}${index === 0 ? `${SGR.dim}  default${SGR.reset}` : ''}`);
        for (const detail of [handler.description, handler.reason]) {
          for (const line of wrap(printable(detail), width - 4)) {
            panelHandlerRows.set(lines.length, index);
            lines.push(`    ${SGR.dim}${line}${SGR.reset}`);
          }
        }
      });
      lines.push('', `${SGR.dim}${clip(`rules: ${shortPath(config, options.home)}`, width)}${SGR.reset}`);
      return lines;
    };

    const renderStatus = (columns: number): string => {
      if (options.fixedTool !== undefined) return clip(`→ ${printable(options.fixedTool)} (--tool)`, columns);
      const state = handlerState();
      if (!state || state.status === 'loading') return `${SGR.dim}→ …${SGR.reset}`;
      if (state.status === 'error') return `${SGR.dim}${clip(`→ unknown: ${printable(state.message)}`, columns)}${SGR.reset}`;
      const { handlers } = state.response;
      if (handlers.length === 0) return `${SGR.dim}${clip('→ nothing opens this file', columns)}${SGR.reset}`;
      const handler = handlers[handlerIndex];
      const position = handlers.length > 1 ? ` (${handlerIndex + 1}/${handlers.length})` : '';
      const head = `→ ${printable(handler.tool)}${position}`;
      const rest = ` · ${printable(handler.description)} · ${printable(handler.reason)}`;
      return `${SGR.bold}${clip(head, columns)}${SGR.reset}${SGR.dim}${clip(rest, columns - displayWidth(head))}${SGR.reset}`;
    };

    const renderHints = (columns: number): string => {
      const hints = ['↑↓ select', ...(handlerList().length > 1 ? ['⇥ handler'] : []), '⏎ open', 'esc cancel'];
      return `${SGR.dim}${clip(hints.join('  '), columns)}${SGR.reset}`;
    };

    terminal.write(ENTER_SCREEN);
    const stop = terminal.listen(onInput, () => { if (!done) render(); });
    render();
    options.files.then((list) => {
      if (done) return;
      all = list.files;
      truncated = list.truncated;
      refilter();
      requestHandlers();
      render();
    }, () => {
      if (done) return;
      all = [];
      render();
    });
  });
}

/** A list row: the directory dim, the basename plain, matched characters
 *  bright; a path too wide loses its leading characters. */
function renderItem(result: Result, selected: boolean, width: number): string {
  const matched = new Set(result.positions);
  const base = result.item.lastIndexOf('/') + 1;
  let cells: { text: string; style: string; width: number }[] = [];
  let index = 0;
  for (const char of result.item) {
    const style = matched.has(index) ? SGR.match : index < base ? SGR.dim : '';
    const text = printable(char);
    cells.push({ text, style, width: displayWidth(text) });
    index += char.length;
  }
  const available = width - 2;
  let total = cells.reduce((sum, cell) => sum + cell.width, 0);
  if (total > available) {
    while (cells.length > 0 && total > available - 1) total -= cells.shift()!.width;
    cells = [{ text: '…', style: SGR.dim, width: 1 }, ...cells];
  }
  const pointer = selected ? `${SGR.accent}›${SGR.reset} ` : '  ';
  let body = '';
  let style: string | undefined;
  for (const cell of cells) {
    if (cell.style !== style) body += `${SGR.reset}${selected ? SGR.bold : ''}${(style = cell.style)}`;
    body += cell.text;
  }
  return `${pointer}${body}${SGR.reset}`;
}

type Key =
  | { kind: 'text' | 'paste'; text: string }
  | { kind: 'click'; row: number; column: number }
  | { kind: 'backspace' | 'clear' | 'word' | 'up' | 'down' | 'pageUp' | 'pageDown' | 'home' | 'end'
      | 'nextHandler' | 'previousHandler' | 'enter' | 'cancel' | 'wheelUp' | 'wheelDown' };

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
      keys.push({ kind: 'paste', text: stripControls(chunk.slice(i + PASTE_START.length, stop).replace(/[\r\n\t]+/g, ' ')) });
      i = end < 0 ? chunk.length : end + PASTE_END.length;
      continue;
    }
    const char = chunk[i];
    if (char === ESC) {
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(chunk.slice(i));
      if (mouse) {
        const [whole, button, column, row, kind] = mouse;
        const code = Number(button);
        if (code === 64) keys.push({ kind: 'wheelUp' });
        else if (code === 65) keys.push({ kind: 'wheelDown' });
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
    if (!CONTROLS.test(text)) {
      const last = keys[keys.length - 1];
      if (last?.kind === 'text') last.text += text;
      else keys.push({ kind: 'text', text });
    }
    i += text.length;
  }
  return keys;
}

/** C0, DEL, and C1 controls: a file name or host message can carry them. */
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/;
const CONTROLS_GLOBAL = /[\x00-\x1f\x7f-\x9f]/g;

function stripControls(text: string): string {
  return text.replace(CONTROLS_GLOBAL, '');
}


function shortPath(path: string, home: string | undefined): string {
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
function clip(text: string, width: number): string {
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
function padTo(text: string, width: number): string {
  return text + SGR.reset + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** Plain text broken at spaces into lines of at most `width` columns. */
function wrap(text: string, width: number): string[] {
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
