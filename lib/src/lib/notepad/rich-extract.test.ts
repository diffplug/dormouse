import { describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import type { Selection } from '../mouse-selection';
import { extractSelectionText } from '../selection-text';
import { extractRichRuns, type CellLike, type TerminalLike, type TerminalPalette } from './rich-extract';

const THEME: TerminalPalette = {
  foreground: '#cccccc',
  background: '#1e1e1e',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
};

type Color = { palette: number } | { rgb: number };

interface Attrs {
  bold?: boolean;
  italic?: boolean;
  inverse?: boolean;
  fg?: Color;
  bg?: Color;
  /** Cell width; 2 marks a wide character, whose continuation cell is added automatically. */
  width?: number;
}

function makeCell(chars: string, attrs: Attrs = {}, width = attrs.width ?? 1): CellLike {
  const { fg, bg } = attrs;
  return {
    getChars: () => chars,
    getWidth: () => width,
    isBold: () => (attrs.bold ? 1 : 0),
    isItalic: () => (attrs.italic ? 1 : 0),
    isInverse: () => (attrs.inverse ? 1 : 0),
    isFgDefault: () => fg === undefined,
    isFgPalette: () => !!fg && 'palette' in fg,
    isFgRGB: () => !!fg && 'rgb' in fg,
    getFgColor: () => (fg ? ('palette' in fg ? fg.palette : fg.rgb) : 0),
    isBgDefault: () => bg === undefined,
    isBgPalette: () => !!bg && 'palette' in bg,
    isBgRGB: () => !!bg && 'rgb' in bg,
    getBgColor: () => (bg ? ('palette' in bg ? bg.palette : bg.rgb) : 0),
  };
}

/** One cell per character of `text`, all sharing `attrs`. */
function styled(text: string, attrs: Attrs = {}): CellLike[] {
  const cells: CellLike[] = [];
  for (const ch of text) {
    cells.push(makeCell(ch, attrs, attrs.width ?? 1));
    // xterm follows a width-2 cell with a width-0 continuation carrying no chars.
    if (attrs.width === 2) cells.push(makeCell('', attrs, 0));
  }
  return cells;
}

interface RowSpec {
  cells: CellLike[];
  wrapped?: boolean;
}

function row(cells: CellLike[], wrapped = false): RowSpec {
  return { cells, wrapped };
}

/** A terminal whose `translateToString` is derived from the same cells the rich
 *  walk reads, so `rawText` and the runs cannot disagree for spurious reasons. */
function makeTerminal(rows: RowSpec[], cols: number): TerminalLike {
  const lines = rows.map((spec) => {
    // xterm allocates every line to `cols`; the tail is unwritten cells.
    const cells = spec.cells.slice(0, cols);
    while (cells.length < cols) cells.push(makeCell('', {}));
    return {
      isWrapped: spec.wrapped ?? false,
      length: cells.length,
      getCell: (x: number) => cells[x],
      translateToString: (_trimRight?: boolean, start = 0, end = cells.length) => {
        let out = '';
        for (let x = Math.max(0, start); x < Math.min(end, cells.length); x += 1) {
          const cell = cells[x];
          if (cell.getWidth() === 0) continue;
          const chars = cell.getChars();
          out += chars === '' ? ' ' : chars;
        }
        return out;
      },
    };
  });
  return { cols, buffer: { active: { getLine: (y: number) => lines[y] } } };
}

function sel(overrides: Partial<Selection>): Selection {
  return {
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    shape: 'linewise',
    dragging: false,
    startedInScrollback: false,
    ...overrides,
  };
}

/** Whole first row of a one-row terminal sized to the content. */
function wholeRow(cells: CellLike[]): { terminal: TerminalLike; selection: Selection } {
  const cols = cells.length;
  return {
    terminal: makeTerminal([row(cells)], cols),
    selection: sel({ endCol: cols - 1 }),
  };
}

describe('extractRichRuns styling', () => {
  it('emits one unstyled run for plain text', () => {
    const { terminal, selection } = wholeRow(styled('hello'));
    expect(extractRichRuns(terminal, selection, THEME).runs).toEqual([{ text: 'hello' }]);
  });

  it('carries bold and italic', () => {
    const { terminal, selection } = wholeRow([
      ...styled('bo', { bold: true }),
      ...styled('it', { italic: true }),
      ...styled('bi', { bold: true, italic: true }),
    ]);
    expect(extractRichRuns(terminal, selection, THEME).runs).toEqual([
      { text: 'bo', bold: true },
      { text: 'it', italic: true },
      { text: 'bi', bold: true, italic: true },
    ]);
  });

  it('resolves palette 0-15 through the theme, foreground and background', () => {
    const { terminal, selection } = wholeRow(
      styled('warn', { fg: { palette: 1 }, bg: { palette: 4 } }),
    );
    expect(extractRichRuns(terminal, selection, THEME).runs).toEqual([
      { text: 'warn', foreground: '#cd3131', background: '#2472c8' },
    ]);
  });

  it('unpacks 24-bit RGB colors', () => {
    const { terminal, selection } = wholeRow(
      styled('rgb', { fg: { rgb: 0x1234ab }, bg: { rgb: 0x00ff00 } }),
    );
    expect(extractRichRuns(terminal, selection, THEME).runs).toEqual([
      { text: 'rgb', foreground: '#1234ab', background: '#00ff00' },
    ]);
  });

  it('computes the 256-color cube and gray ramp', () => {
    const { terminal, selection } = wholeRow([
      ...styled('a', { fg: { palette: 196 } }),
      ...styled('b', { fg: { palette: 232 } }),
      ...styled('c', { fg: { palette: 255 } }),
      ...styled('d', { fg: { palette: 16 } }),
      ...styled('e', { fg: { palette: 231 } }),
      ...styled('f', { fg: { palette: 33 } }),
    ]);
    expect(extractRichRuns(terminal, selection, THEME).runs).toEqual([
      { text: 'a', foreground: '#ff0000' },
      { text: 'b', foreground: '#080808' },
      { text: 'c', foreground: '#eeeeee' },
      { text: 'd', foreground: '#000000' },
      { text: 'e', foreground: '#ffffff' },
      { text: 'f', foreground: '#0087ff' },
    ]);
  });

  it('omits defaulted colors entirely', () => {
    const { terminal, selection } = wholeRow(styled('x', { bold: true }));
    const [run] = extractRichRuns(terminal, selection, THEME).runs;
    expect(run).toEqual({ text: 'x', bold: true });
    expect('foreground' in run).toBe(false);
    expect('background' in run).toBe(false);
  });

  it('swaps explicit colors on an inverse cell', () => {
    const { terminal, selection } = wholeRow(
      styled('inv', { inverse: true, fg: { palette: 2 }, bg: { rgb: 0x112233 } }),
    );
    expect(extractRichRuns(terminal, selection, THEME).runs).toEqual([
      { text: 'inv', foreground: '#112233', background: '#0dbc79' },
    ]);
  });

  it('makes the theme defaults explicit on an inverse cell that had none', () => {
    const { terminal, selection } = wholeRow(styled('inv', { inverse: true }));
    expect(extractRichRuns(terminal, selection, THEME).runs).toEqual([
      { text: 'inv', foreground: THEME.background, background: THEME.foreground },
    ]);
  });

  it('normalizes theme colors that are not already #rrggbb', () => {
    const loose: TerminalPalette = { ...THEME, red: 'rgb(255, 0, 8)', background: '#ABC' };
    const { terminal, selection } = wholeRow([
      ...styled('r', { fg: { palette: 1 } }),
      ...styled('i', { inverse: true }),
    ]);
    expect(extractRichRuns(terminal, selection, loose).runs).toEqual([
      { text: 'r', foreground: '#ff0008' },
      { text: 'i', foreground: '#aabbcc', background: '#cccccc' },
    ]);
  });

  it('drops a color the theme cannot supply', () => {
    const broken: TerminalPalette = { ...THEME, cyan: 'var(--nope)' };
    const { terminal, selection } = wholeRow(styled('c', { fg: { palette: 6 } }));
    expect(extractRichRuns(terminal, selection, broken).runs).toEqual([{ text: 'c' }]);
  });
});

describe('extractRichRuns bold-in-bright mapping', () => {
  const { terminal, selection } = wholeRow(styled('hot', { bold: true, fg: { palette: 1 } }));

  it('promotes palette 0-7 to the bright half by default', () => {
    expect(extractRichRuns(terminal, selection, THEME).runs).toEqual([
      { text: 'hot', bold: true, foreground: '#f14c4c' },
    ]);
  });

  it('leaves the palette alone when the terminal has the option off', () => {
    const opts = { drawBoldTextInBrightColors: false };
    expect(extractRichRuns(terminal, selection, THEME, opts).runs).toEqual([
      { text: 'hot', bold: true, foreground: '#cd3131' },
    ]);
  });

  it('never promotes a bright entry, a 256-color entry, or a background', () => {
    const wide = wholeRow([
      ...styled('a', { bold: true, fg: { palette: 9 } }),
      ...styled('b', { bold: true, fg: { palette: 196 } }),
      ...styled('c', { bold: true, bg: { palette: 1 } }),
    ]);
    expect(extractRichRuns(wide.terminal, wide.selection, THEME).runs).toEqual([
      { text: 'a', bold: true, foreground: '#f14c4c' },
      { text: 'b', bold: true, foreground: '#ff0000' },
      { text: 'c', bold: true, background: '#cd3131' },
    ]);
  });
});

describe('extractRichRuns cell walking', () => {
  it('includes a wide character once, with its own styling', () => {
    const { terminal, selection } = wholeRow([
      ...styled('a'),
      ...styled('日本', { width: 2, bold: true }),
      ...styled('b'),
    ]);
    const { runs, rawText } = extractRichRuns(terminal, selection, THEME);
    expect(runs).toEqual([
      { text: 'a' },
      { text: '日本', bold: true },
      { text: 'b' },
    ]);
    expect(rawText).toBe('a日本b');
  });

  it('reads an unwritten cell inside the range as a space', () => {
    const terminal = makeTerminal([row([...styled('ab'), makeCell('', {}), ...styled('cd')])], 5);
    const runs = extractRichRuns(terminal, sel({ endCol: 4 }), THEME).runs;
    expect(runs).toEqual([{ text: 'ab cd' }]);
  });

  it('normalizes a reversed selection', () => {
    const terminal = makeTerminal([row(styled('The quick brown fox'))], 19);
    const forward = sel({ startCol: 4, endCol: 8 });
    const reversed = sel({ startCol: 8, endCol: 4 });
    expect(extractRichRuns(terminal, reversed, THEME).runs).toEqual([{ text: 'quick' }]);
    expect(extractRichRuns(terminal, reversed, THEME)).toEqual(extractRichRuns(terminal, forward, THEME));
  });

  it('normalizes a reversed multi-row selection', () => {
    const terminal = makeTerminal([row(styled('alpha')), row(styled('beta'))], 5);
    const reversed = sel({ startRow: 1, startCol: 3, endRow: 0, endCol: 1 });
    expect(extractRichRuns(terminal, reversed, THEME).runs).toEqual([{ text: 'lpha\nbeta' }]);
  });
});

describe('extractRichRuns row joining', () => {
  it('joins a soft-wrapped row with no separator and keeps its trailing spaces', () => {
    const terminal = makeTerminal([
      row([...styled('long line '), ...styled('')]),
      row(styled('continues'), true),
    ], 10);
    const s = sel({ startRow: 0, startCol: 0, endRow: 1, endCol: 8 });
    expect(extractRichRuns(terminal, s, THEME).runs).toEqual([{ text: 'long line continues' }]);
  });

  it('keeps a hard break and trims the trailing whitespace before it', () => {
    const terminal = makeTerminal([row(styled('one')), row(styled('two'))], 10);
    const s = sel({ startRow: 0, startCol: 0, endRow: 1, endCol: 9 });
    expect(extractRichRuns(terminal, s, THEME).runs).toEqual([{ text: 'one\ntwo' }]);
  });

  it('trims trailing whitespace off the last row too', () => {
    const terminal = makeTerminal([row(styled('tail   '))], 10);
    const s = sel({ startRow: 0, startCol: 0, endRow: 0, endCol: 9 });
    expect(extractRichRuns(terminal, s, THEME).runs).toEqual([{ text: 'tail' }]);
  });

  it('trims into a styled run without disturbing the style', () => {
    const terminal = makeTerminal([row([...styled('ok'), ...styled('  ', { bold: true })])], 6);
    const s = sel({ startRow: 0, startCol: 0, endRow: 0, endCol: 5 });
    expect(extractRichRuns(terminal, s, THEME).runs).toEqual([{ text: 'ok' }]);
  });

  it('emits the break unstyled so a background does not bleed across rows', () => {
    const terminal = makeTerminal([
      row(styled('aa', { bg: { palette: 4 } })),
      row(styled('bb', { bg: { palette: 4 } })),
    ], 2);
    const s = sel({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    expect(extractRichRuns(terminal, s, THEME).runs).toEqual([
      { text: 'aa', background: '#2472c8' },
      { text: '\n' },
      { text: 'bb', background: '#2472c8' },
    ]);
  });

  it('treats every row of a block selection as a hard break, wrapped or not', () => {
    const terminal = makeTerminal([
      row(styled('The quick brown fox')),
      row(styled('jumps over the lazy'), true),
      row(styled('dog and runs away.,'), true),
    ], 19);
    const s = sel({ startRow: 0, startCol: 4, endRow: 2, endCol: 8, shape: 'block' });
    expect(extractRichRuns(terminal, s, THEME).runs).toEqual([{ text: 'quick\ns ove\nand r' }]);
  });

  it('skips a missing row without leaving a separator behind, as the raw read does', () => {
    const terminal = makeTerminal([row(styled('one')), row(styled('two'))], 3);
    const s = sel({ startRow: 0, startCol: 0, endRow: 4, endCol: 2 });
    expect(extractRichRuns(terminal, s, THEME).runs).toEqual([{ text: 'one\ntwo' }]);
  });
});

describe('extractRichRuns run merging', () => {
  it('merges adjacent cells with identical supported styling', () => {
    const { terminal, selection } = wholeRow([
      ...styled('aaa', { bold: true, fg: { palette: 2 } }),
      ...styled('bbb', { bold: true, fg: { palette: 2 } }),
    ]);
    expect(extractRichRuns(terminal, selection, THEME).runs).toEqual([
      { text: 'aaabbb', bold: true, foreground: '#23d18b' },
    ]);
  });

  it('merges two palettes that resolve to the same color', () => {
    // palette 15 and 231 are both #ffffff in this theme.
    const { terminal, selection } = wholeRow([
      ...styled('x', { fg: { palette: 15 } }),
      ...styled('y', { fg: { palette: 231 } }),
    ]);
    expect(extractRichRuns(terminal, selection, THEME).runs).toEqual([
      { text: 'xy', foreground: '#ffffff' },
    ]);
  });

  it('does not merge across a foreground change', () => {
    const { terminal, selection } = wholeRow([
      ...styled('r', { fg: { palette: 1 } }),
      ...styled('g', { fg: { palette: 2 } }),
    ]);
    expect(extractRichRuns(terminal, selection, THEME).runs).toHaveLength(2);
  });

  it('never emits an empty run', () => {
    const terminal = makeTerminal([row(styled('  ')), row(styled('x'))], 2);
    const s = sel({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
    const runs = extractRichRuns(terminal, s, THEME).runs;
    expect(runs.every((run) => run.text.length > 0)).toBe(true);
    expect(runs).toEqual([{ text: '\nx' }]);
  });

  it('returns nothing for a selection with no content', () => {
    const terminal = makeTerminal([row(styled('   '))], 3);
    const s = sel({ startRow: 0, startCol: 0, endRow: 0, endCol: 2 });
    expect(extractRichRuns(terminal, s, THEME).runs).toEqual([]);
  });
});

describe('extractRichRuns rawText', () => {
  const terminal = makeTerminal([
    row([...styled('The quick', { bold: true }), ...styled(' brown fox')]),
    row(styled('jumps over the lazy'), true),
    row(styled('dog and runs away.')),
  ], 19);

  const cases: Array<[string, Selection]> = [
    ['single row', sel({ startCol: 4, endCol: 8 })],
    ['multi row', sel({ startRow: 0, startCol: 10, endRow: 2, endCol: 2 })],
    ['reversed', sel({ startRow: 2, startCol: 2, endRow: 0, endCol: 10 })],
    ['block', sel({ startRow: 0, startCol: 4, endRow: 2, endCol: 8, shape: 'block' })],
    ['whole buffer', sel({ startRow: 0, startCol: 0, endRow: 2, endCol: 18 })],
  ];

  it.each(cases)('matches extractSelectionText exactly (%s)', (_name, s) => {
    expect(extractRichRuns(terminal, s, THEME).rawText)
      .toBe(extractSelectionText(terminal as Terminal, s));
  });

  it('differs from the run text where a soft wrap was rejoined', () => {
    const s = sel({ startRow: 0, startCol: 0, endRow: 1, endCol: 18 });
    const { runs, rawText } = extractRichRuns(terminal, s, THEME);
    const runText = runs.map((run) => run.text).join('');
    expect(rawText).toBe('The quick brown fox\njumps over the lazy');
    expect(runText).toBe('The quick brown foxjumps over the lazy');
  });
});
