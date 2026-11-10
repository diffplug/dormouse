/**
 * `dor open` with no path: a full-screen fuzzy file picker that shows which
 * handler each file opens with and why, and lets the person choose another
 * (`docs/specs/dor-tool.md` -> Choosing a file).
 */
import type { OpenHandlersResponse, PickerTerminal } from './types.js';
import { fuzzyMatch, Ranker } from './fuzzy.js';
import { printable } from './terminal-text.js';
import {
  cellsWidth, clip, dim, displayWidth, openPickerScreen, packHints, padTo, PickerList, renderRow, SGR, shortPath, textCells, wrap,
  type Key,
} from './picker-core.js';

export interface PickerChoice {
  /** Relative to the listing directory, `/`-separated. */
  file: string;
  /** The chosen handler; absent for the default `dor open` selects. */
  tool?: string;
}

export interface PickerOptions {
  terminal: PickerTerminal;
  /** Streams the files, batch by batch, until the listing ends. */
  listFiles(onFiles: (paths: string[]) => void, signal: AbortSignal): Promise<{ truncated: boolean }>;
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
/** How often streamed files and slices of ranking redraw the screen. */
const REDRAW_MS = 50;

const NUMBER = new Intl.NumberFormat('en-US');

export function runFilePicker(options: PickerOptions): Promise<PickerChoice | null> {
  const { terminal } = options;
  /** Null while listing, then whether the limit cut the listing short. */
  let listed: { truncated: boolean } | null = null;
  let handlerIndex = 0;
  let handlerFile: string | undefined;
  const handlerCache = new Map<string, HandlerState>();
  let handlerTimer: ReturnType<typeof setTimeout> | undefined;
  let handlerInFlight = false;
  /** Screen rows (0-based) whose click chooses a handler. */
  let handlerRows = new Map<number, number>();
  let redrawTimer: ReturnType<typeof setTimeout> | undefined;
  const listing = new AbortController();

  return new Promise((resolve) => {
    let done = false;
    const finish = (choice: PickerChoice | null) => {
      if (done) return;
      done = true;
      clearTimeout(handlerTimer);
      clearTimeout(redrawTimer);
      listing.abort();
      ranker.dispose();
      screen.close();
      resolve(choice);
    };

    /** Streamed files and ranking slices redraw at most every REDRAW_MS. */
    const ranker = new Ranker(() => {
      if (redrawTimer === undefined) redrawTimer = setTimeout(() => { redrawTimer = undefined; if (!done) render(); }, REDRAW_MS);
    });
    const list = new PickerList(ranker);

    const current = (): string | undefined => ranker.at(ranker.cursor);
    const handlerState = (): HandlerState | undefined => {
      const file = current();
      return file === undefined ? undefined : handlerCache.get(file);
    };
    const handlerList = () => {
      const state = handlerState();
      return state?.status === 'ok' ? state.response.handlers : [];
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

    /** Choosing a handler also holds its file under the cursor as results arrive. */
    const chooseHandler = (index: number) => {
      handlerIndex = index;
      ranker.select(ranker.cursor);
    };
    const cycleHandler = (delta: number) => {
      const count = handlerList().length;
      if (count > 1) chooseHandler((handlerIndex + delta + count) % count);
    };

    const accept = () => {
      ranker.flush();
      const file = current();
      if (file === undefined) return;
      // The chosen handler belongs to `handlerFile`; a query edit in the same
      // input chunk as Enter can change the file before a render resets it.
      // The first handler is the default and opens without `--tool`, so a host
      // refusing the handler read still leaves the file openable.
      const handler = handlerIndex > 0 && file === handlerFile ? handlerList()[handlerIndex] : undefined;
      finish(handler ? { file, tool: handler.tool } : { file });
    };

    const click = (row: number, column: number) => {
      const handler = handlerRows.get(row);
      if (handler !== undefined && (column >= listWidth() + 2 || row > list.rows)) {
        if (handler < 0) cycleHandler(1);
        else chooseHandler(handler);
        return;
      }
      if (column < listWidth() && list.click(row) === 'repeat') accept();
    };

    const onKeys = (keys: Key[]) => {
      for (const key of keys) {
        if (!list.key(key)) switch (key.kind) {
          case 'nextHandler': cycleHandler(1); break;
          case 'previousHandler': cycleHandler(-1); break;
          case 'enter': accept(); break;
          case 'cancel': finish(null); break;
          case 'click': click(key.row, key.column); break;
        }
        if (done) return;
      }
      // A query edit restarts ranking; without a slice now, this frame would
      // paint an empty list until the deferred scan catches up.
      ranker.seed();
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
      const cursor = list.layout(rows - 1 - (panel ? 0 : 2));
      const { scroll, query } = list;
      if (current() !== handlerFile) requestHandlers();
      const width = listWidth();
      const lines: string[] = [];
      handlerRows = new Map();

      const total = `${NUMBER.format(ranker.size)}${!listed ? '…' : listed.truncated ? '+ · capped, run from a subfolder' : ''}`;
      const count = `${NUMBER.format(ranker.count)}${ranker.scanning ? '…' : ''}/${total}`;
      const head = list.queryRow(columns, count);
      lines.push(head.line);

      const panelLines = panel ? renderPanel(columns - width - 3) : [];
      for (let row = 0; row < list.rows; row++) {
        let line: string;
        if (ranker.size === 0 && row === 0) line = dim(listed ? '  No files here' : '  Listing files…');
        else {
          const item = ranker.at(scroll + row);
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

      // Handler replies and ranking ticks often change nothing visible.
      screen.paint(lines, columns, rows, head.cursorColumn);
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

    const screen = openPickerScreen(terminal, onKeys, () => { if (!done) render(); });
    render();
    options.listFiles(paths => ranker.add(paths), listing.signal).then(
      result => { listed = result; },
      () => { listed = { truncated: false }; },
    ).finally(() => { if (!done) render(); });
  });
}


/** A list row: the directory dim, the basename plain, matched characters
 *  bright; a path too wide loses its leading characters. */
function renderItem(item: string, positions: readonly number[], selected: boolean, width: number): string {
  const matched = new Set(positions);
  const base = item.lastIndexOf('/') + 1;
  let cells = textCells(item, index => (matched.has(index) ? SGR.match : index < base ? SGR.dim : ''));
  const available = width - 2;
  let total = cellsWidth(cells);
  if (total > available) {
    while (cells.length > 0 && total > available - 1) total -= cells.shift()!.width;
    cells = [{ text: '…', style: SGR.dim, width: 1 }, ...cells];
  }
  return renderRow(cells, selected);
}
