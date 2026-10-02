/**
 * `dor open` with no path: a full-screen fuzzy file picker that shows which
 * handler each file opens with and why, and lets the person choose another
 * (`docs/specs/dor-tool.md` -> Choosing a file).
 */
import type { OpenHandlersResponse, PickerTerminal } from './types.js';
import type { FileList } from './file-list.js';
import { fuzzyMatch, rankMatches } from './fuzzy.js';
import { printable, stripControls } from './shared.js';

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

/** A drawn line, and the handler a click on it chooses (-1: the next one). */
interface Line { text: string; handler?: number }

/** Wide enough for a list and a handler panel beside it. */
const PANEL_MIN_COLUMNS = 100;
const HANDLER_DEBOUNCE_MS = 30;
const DOUBLE_CLICK_MS = 400;

const ESC = '\x1b';
const CSI = `${ESC}[`;
const SGR = {
  reset: `${CSI}0m`, bold: `${CSI}1m`, dim: `${CSI}2m`,
  match: `${CSI}1;36m`, accent: `${CSI}1;33m`,
};
const dim = (text: string) => `${SGR.dim}${text}${SGR.reset}`;
const ENTER_SCREEN = `${CSI}?1049h${CSI}?1000h${CSI}?1006h${CSI}?2004h`;
const LEAVE_SCREEN = `${CSI}?2004l${CSI}?1006l${CSI}?1000l${CSI}?25h${CSI}?1049l`;

export function runFilePicker(options: PickerOptions): Promise<PickerChoice | null> {
  const { terminal } = options;
  let list: FileList | null = null;
  let query = '';
  /** Ranked matches for `query`; stale while `dirty`. */
  let results: string[] = [];
  let dirty = false;
  /** The items matching `poolQuery`, in listing order: a longer query only narrows it. */
  let pool: string[] = [];
  let poolQuery = '';
  let cursor = 0;
  let scroll = 0;
  let handlerIndex = 0;
  let handlerFile: string | undefined;
  const handlerCache = new Map<string, HandlerState>();
  let handlerTimer: ReturnType<typeof setTimeout> | undefined;
  let handlerInFlight = false;
  let lastClick = { row: -1, at: 0 };
  /** Screen rows (0-based) whose click chooses a handler. */
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

    const current = (): string | undefined => results[cursor];
    const handlerState = (): HandlerState | undefined => {
      const file = current();
      return file === undefined ? undefined : handlerCache.get(file);
    };
    const handlerList = () => {
      const state = handlerState();
      return state?.status === 'ok' ? state.response.handlers : [];
    };

    /** Reranks once per input chunk, so a burst of keys costs one scan. */
    const refilter = () => {
      if (!list || !dirty) return;
      dirty = false;
      const narrows = poolQuery.trim() !== '' && query.startsWith(poolQuery);
      ({ results, matched: pool } = rankMatches(query, narrows ? pool : list.files));
      poolQuery = query;
      cursor = 0;
      scroll = 0;
      requestHandlers();
    };

    /** At most one read in flight: holding an arrow key asks only about where it stops. */
    const requestHandlers = () => {
      clearTimeout(handlerTimer);
      const file = current();
      if (file !== handlerFile) {
        handlerFile = file;
        handlerIndex = 0;
      }
      if (options.fixedTool !== undefined || file === undefined || handlerCache.has(file) || handlerInFlight) return;
      handlerTimer = setTimeout(() => {
        handlerInFlight = true;
        handlerCache.set(file, { status: 'loading' });
        render();
        options.handlers(file).then(
          response => handlerCache.set(file, { status: 'ok', response }),
          (error: unknown) => handlerCache.set(file, { status: 'error', message: error instanceof Error ? error.message : String(error) }),
        ).finally(() => {
          handlerInFlight = false;
          if (done) return;
          requestHandlers();
          render();
        });
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
      const handler = handlerIndex > 0 ? handlerList()[handlerIndex] : undefined;
      finish(handler ? { file, tool: handler.tool } : { file });
    };

    const setQuery = (next: string) => {
      if (next === query) return;
      query = next;
      dirty = true;
    };

    const click = (row: number, column: number) => {
      const handler = handlerRows.get(row);
      if (handler !== undefined && (column >= listWidth() + 2 || row > listRows)) {
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
        // Navigation reads the ranking a typed key changed.
        if (key.kind !== 'text' && key.kind !== 'backspace' && key.kind !== 'clear' && key.kind !== 'word') refilter();
        switch (key.kind) {
          case 'text': setQuery(query + key.text); break;
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
          case 'cancel': finish(null); break;
          case 'click': click(key.row, key.column); break;
        }
        if (done) return;
      }
      refilter();
      render();
    };

    const wide = () => terminal.columns() >= PANEL_MIN_COLUMNS;
    const listWidth = () => (wide() ? Math.floor(terminal.columns() * 0.55) : terminal.columns());

    const render = () => {
      const columns = Math.max(20, terminal.columns());
      const rows = Math.max(4, terminal.rows());
      const panel = wide();
      // The panel heads with the key hints; narrow terminals put the handler on
      // a status line above them at the bottom.
      listRows = rows - 1 - (panel ? 0 : 2);
      if (cursor >= scroll + listRows) scroll = cursor - listRows + 1;
      const width = listWidth();
      const lines: string[] = [];
      handlerRows = new Map();

      const count = list ? `${results.length}/${list.files.length}${list.truncated ? '+' : ''}` : '';
      const shown = clip(printable(query), columns - 4 - count.length);
      lines.push(padTo(`${SGR.accent}>${SGR.reset} ${shown}`, columns - count.length) + dim(count));

      const panelLines = panel ? renderPanel(columns - width - 3) : [];
      for (let row = 0; row < listRows; row++) {
        let line: string;
        if (!list) line = row === 0 ? dim('  Listing files…') : '';
        else if (list.files.length === 0 && row === 0) line = dim('  No files here');
        else {
          const item = results[scroll + row];
          line = item === undefined ? '' : renderItem(item, fuzzyMatch(query, item)?.positions ?? [], scroll + row === cursor, width);
        }
        if (panel) {
          const side = panelLines[row];
          line = padTo(line, width) + ` ${dim('│')} ` + (side?.text ?? '');
          if (side?.handler !== undefined) handlerRows.set(row + 1, side.handler);
        }
        lines.push(line);
      }
      if (!panel) {
        lines.push(renderStatus(columns));
        if (handlerList().length > 1) handlerRows.set(rows - 2, -1);
        lines.push(dim(clip(hints().join('  '), columns)));
      }

      let out = `${CSI}?2026h${CSI}?25l`;
      lines.forEach((line, index) => { out += `${CSI}${index + 1};1H${line}${SGR.reset}${CSI}K`; });
      out += `${CSI}1;${3 + displayWidth(shown)}H${CSI}?25h${CSI}?2026l`;
      terminal.write(out);
    };

    const renderPanel = (width: number): Line[] => {
      const lines: Line[] = [...packHints(hints(), width).map(text => ({ text: dim(text) })), { text: '' }, { text: `${SGR.bold}Opens with${SGR.reset}` }];
      const plain = (text: string) => wrap(text, width).map(line => ({ text: dim(line) }));
      if (options.fixedTool !== undefined) {
        return [...lines, { text: `${SGR.accent}›${SGR.reset} ${SGR.bold}${clip(printable(options.fixedTool), width - 2)}${SGR.reset}` },
          { text: dim('    chosen by --tool') }];
      }
      const state = handlerState();
      if (current() === undefined) return lines;
      if (!state || state.status === 'loading') return [...lines, { text: dim('  …') }];
      if (state.status === 'error') return [...lines, ...plain(`Unknown: ${printable(state.message)}`), { text: '' }, ...plain('Enter opens it as dor open would.')];
      const { handlers, config } = state.response;
      if (handlers.length === 0) return [...lines, ...plain(`Nothing opens this file. Add an open rule to ${shortPath(config, options.home)}.`)];
      handlers.forEach((handler, index) => {
        const chosen = index === handlerIndex;
        const name = clip(printable(handler.tool), width - 4 - (index === 0 ? 10 : 0));
        lines.push({ handler: index, text: `${chosen ? `${SGR.accent}›${SGR.reset} ${SGR.bold}` : '  '}${name}${SGR.reset}${index === 0 ? dim('  default') : ''}` });
        for (const detail of [handler.description, handler.reason]) {
          for (const line of wrap(printable(detail), width - 4)) lines.push({ handler: index, text: `    ${dim(line)}` });
        }
      });
      return [...lines, { text: '' }, { text: dim(clip(`rules: ${shortPath(config, options.home)}`, width)) }];
    };

    const renderStatus = (columns: number): string => {
      if (options.fixedTool !== undefined) return clip(`→ ${printable(options.fixedTool)} (--tool)`, columns);
      const state = handlerState();
      if (!state || state.status === 'loading') return dim('→ …');
      if (state.status === 'error') return dim(clip(`→ unknown: ${printable(state.message)}`, columns));
      const { handlers } = state.response;
      if (handlers.length === 0) return dim(clip('→ nothing opens this file', columns));
      const handler = handlers[handlerIndex];
      const position = handlers.length > 1 ? ` (${handlerIndex + 1}/${handlers.length})` : '';
      const head = `→ ${printable(handler.tool)}${position}`;
      const rest = ` · ${printable(handler.description)} · ${printable(handler.reason)}`;
      return `${SGR.bold}${clip(head, columns)}${SGR.reset}${dim(clip(rest, columns - displayWidth(head)))}`;
    };

    const hints = () => ['Select [↑↓]', 'Open [Enter]', ...(handlerList().length > 1 ? ['Handler [Tab]'] : [])];

    terminal.write(ENTER_SCREEN);
    const stop = terminal.listen(onInput, () => { if (!done) render(); });
    render();
    options.files.then((files) => {
      if (done) return;
      list = files;
      dirty = true;
      refilter();
      render();
    }, () => {
      if (done) return;
      list = { files: [], truncated: false };
      render();
    });
  });
}

/** A list row: the directory dim, the basename plain, matched characters
 *  bright; a path too wide loses its leading characters. */
function renderItem(item: string, positions: readonly number[], selected: boolean, width: number): string {
  const matched = new Set(positions);
  const base = item.lastIndexOf('/') + 1;
  let cells: { text: string; style: string; width: number }[] = [];
  let index = 0;
  for (const char of item) {
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

/** Keys as the picker acts on them: a paste is text, a wheel notch an arrow. */
type Key =
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

function displayWidth(text: string): number {
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

/** Hints packed whole onto lines of at most `width` columns. */
function packHints(hints: readonly string[], width: number): string[] {
  const lines: string[] = [];
  for (const hint of hints) {
    const last = lines[lines.length - 1];
    if (last !== undefined && displayWidth(`${last}  ${hint}`) <= width) lines[lines.length - 1] = `${last}  ${hint}`;
    else lines.push(clip(hint, width));
  }
  return lines;
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
