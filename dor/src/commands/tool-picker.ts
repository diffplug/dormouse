/**
 * `dor tool` with no name: a full-screen fuzzy picker over the Tools
 * `dor tool --list` reports (`docs/specs/dor-tool.md` -> Choosing a Tool).
 * Every field it draws is repo text, so each passes `printableExact`.
 */
import type { PickerTerminal, ToolListEntry, ToolListResponse } from './types.js';
import { fuzzyMatch, Ranker } from './fuzzy.js';
import { approvalTag, printableExact, toolRunText, toolTags } from './terminal-text.js';
import {
  besidePanel, clip, dim, fitCells, hasPanel, listWidth, openPickerScreen, packHints, PickerList, renderRow, SGR, shortPath, statusLine,
  textCells, wrap, type Cell, type Key,
} from './picker-core.js';

export interface ToolPickerOptions {
  terminal: PickerTerminal;
  /** What `dor tool --list` answered; at least one Tool. */
  listing: ToolListResponse;
  /** Shortens the file paths shown for the highlighted Tool. */
  home?: string;
}

export function runToolPicker(options: ToolPickerOptions): Promise<ToolListEntry | null> {
  const { terminal, listing } = options;
  const tools = listing.tools;

  return new Promise((resolve) => {
    let done = false;
    const finish = (choice: ToolListEntry | null) => {
      if (done) return;
      done = true;
      ranker.dispose();
      screen.close();
      resolve(choice);
    };

    // Names are all there is to rank, and they are few: a scan slice redraws.
    const ranker = new Ranker(() => { if (!done) render(); });
    const list = new PickerList(ranker);
    const current = (): ToolListEntry | undefined => {
      const index = ranker.indexAt(ranker.cursor);
      return index === undefined ? undefined : tools[index];
    };

    const accept = () => {
      ranker.flush();
      const tool = current();
      if (tool) finish(tool);
    };

    const onKeys = (keys: Key[]) => {
      for (const key of keys) {
        if (!list.key(key)) switch (key.kind) {
          case 'enter': accept(); break;
          case 'cancel': finish(null); break;
          case 'click': if (key.column < listWidth(terminal.columns()) && list.click(key.row)) accept(); break;
        }
        if (done) return;
      }
      ranker.seed();
      render();
    };

    const render = () => {
      const columns = Math.max(20, terminal.columns());
      const rows = Math.max(4, terminal.rows());
      const panel = hasPanel(terminal.columns());
      const cursor = list.layout(rows - 1 - (panel ? 0 : 2));
      const width = listWidth(terminal.columns());
      const head = list.queryRow(columns, `${ranker.count}${ranker.scanning ? '…' : ''}/${tools.length}`);
      const lines = [head.line];
      const panelLines = panel ? renderPanel(columns - width - 3) : [];
      for (let row = 0; row < list.rows; row++) {
        const index = ranker.indexAt(list.scroll + row);
        let line = index === undefined
          ? (ranker.count === 0 && row === 0 && !ranker.scanning ? dim('  No Tool matches') : '')
          : renderItem(tools[index], fuzzyMatch(list.query, tools[index].name)?.positions ?? [], list.scroll + row === cursor, width);
        if (panel) line = besidePanel(line, width, panelLines[row] ?? '');
        lines.push(line);
      }
      if (!panel) {
        lines.push(renderStatus(columns));
        lines.push(dim(clip(HINTS.join('  '), columns)));
      }
      screen.paint(lines, columns, rows, head.cursorColumn);
    };

    /** The highlighted Tool in full: its file, tags, command, and description. */
    const renderPanel = (width: number): string[] => {
      const lines = [...packHints(HINTS, width).map(dim), ''];
      const tool = current();
      if (!tool) return lines;
      lines.push(`${SGR.bold}${clip(printableExact(tool.name), width)}${SGR.reset}`);
      for (const line of wrap(tags(tool, listing).join('  '), width)) lines.push(dim(line));
      for (const line of wrap(`${tool.scope}  ${printableExact(shortPath(scopePath(tool, listing), options.home))}`, width)) lines.push(dim(line));
      lines.push('');
      for (const line of wrap(toolRunText(tool), width)) lines.push(line);
      if (tool.description) {
        lines.push('');
        for (const paragraph of tool.description.split('\n')) {
          const wrapped = wrap(printableExact(paragraph), width);
          lines.push(...(wrapped.length ? wrapped.map(dim) : ['']));
        }
      }
      return lines;
    };

    /** Narrow terminals: the tags and the description's first line. */
    const renderStatus = (columns: number): string => {
      const tool = current();
      if (!tool) return '';
      const head = `→ ${tags(tool, listing).join(' ')}`;
      const summary = tool.description?.split('\n').find(line => line.trim());
      return statusLine(head, summary ? ` · ${printableExact(summary)}` : '', columns);
    };

    const screen = openPickerScreen(terminal, onKeys, () => { if (!done) render(); });
    ranker.add(tools.map(tool => tool.name));
    render();
  });
}

const HINTS = ['Select [↑↓]', 'Run [Enter]'];

function scopePath(tool: ToolListEntry, listing: ToolListResponse): string {
  return tool.scope === 'project' ? listing.project?.path ?? '' : listing.user.path;
}

/** The `--list` tags, and for a project Tool whether its file is approved. */
function tags(tool: ToolListEntry, listing: ToolListResponse): string[] {
  return [...toolTags(tool), ...(tool.scope === 'project' ? [approvalTag(listing.project?.approved === true)] : [])];
}

const GAP: Cell = { text: '  ', style: '', width: 2 };

/** A list row: the name, matched characters bright, then its command dim and
 *  a shadowed mark; what does not fit loses its end. */
function renderItem(tool: ToolListEntry, positions: readonly number[], selected: boolean, width: number): string {
  const matched = new Set(positions);
  const cells = [
    ...textCells(tool.name, index => (matched.has(index) ? SGR.match : ''), printableExact),
    GAP,
    ...textCells(tool.broken === undefined ? JSON.stringify(tool.run) : `[broken: ${tool.broken}]`, () => SGR.dim, printableExact),
    ...(tool.shadowed ? [GAP, ...textCells('[shadowed]', () => SGR.dim)] : []),
  ];
  return renderRow(fitCells(cells, width - 2, 'end'), selected);
}
