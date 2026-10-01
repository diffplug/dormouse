// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { selectionOfSpan, type Span } from './copy-text';
import { finalizedSelection, WRAPPING } from './copy-text-fixtures';
import { anchorSelection, followReflow } from './selection-reflow';

/** A finalized linewise selection follows its cells through a resize's reflow
 *  (docs/specs/mouse-and-clipboard.md §3.4). */

const live: Terminal[] = [];
afterEach(() => { for (const terminal of live.splice(0)) terminal.dispose(); });

const write = (terminal: Terminal, data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));

async function terminalWith(data: string, options: { cols: number; rows?: number; scrollback?: number }): Promise<Terminal> {
  const terminal = new Terminal({ rows: 10, ...options, allowProposedApi: true });
  live.push(terminal);
  await write(terminal, data);
  return terminal;
}

const at = (r0: number, c0: number, r1: number, c1: number): Span => ({ start: { row: r0, col: c0 }, end: { row: r1, col: c1 }, block: false });
const linewise = (span: Span) => selectionOfSpan(span, finalizedSelection());

/** Anchor `span`, resize to each width in turn, and follow it after each. */
function followThrough(terminal: Terminal, span: Span, widths: readonly number[]): (Span | null)[] {
  return widths.map((cols) => {
    const anchor = anchorSelection(terminal, linewise(span))!;
    terminal.resize(cols, terminal.rows);
    const moved = followReflow(terminal, anchor);
    anchor.dispose();
    if (moved) span = moved;
    return moved;
  });
}

// At 9 columns `中` cannot fit in the last cell, which xterm leaves blank.
const WIDE = 'abcdefgh中文xyz\r\n';

describe('followReflow', () => {
  it.each([
    {
      name: 'carries a selection across a soft wrap through narrower and wider widths',
      data: `${WRAPPING}\r\n`, options: { cols: 20 }, sel: at(0, 5, 1, 3), // `bbbb` through `eeee`
      widths: [10, 40, 20], moved: [at(0, 5, 2, 3), at(0, 5, 0, 23), at(0, 5, 1, 3)],
    },
    {
      name: 'shifts a selection on hard-wrapped lines below a line that reflows',
      data: `${WRAPPING}\r\nfirst\r\nsecond\r\n`, options: { cols: 20 }, sel: at(2, 0, 3, 5),
      widths: [10, 40], moved: [at(3, 0, 4, 5), at(1, 0, 2, 5)],
    },
    {
      name: 'skips the padding a wide character leaves when it wraps',
      data: WIDE, options: { cols: 9 }, sel: at(0, 7, 1, 2), // `h` through `文`
      widths: [10, 9], moved: [at(0, 7, 1, 0), at(0, 7, 1, 2)],
    },
    {
      name: 'moves a start on wrap padding to where the text resumes',
      data: WIDE, options: { cols: 9 }, sel: at(0, 8, 1, 4), // the padding through `x`
      widths: [10, 9], moved: [at(0, 8, 1, 2), at(1, 0, 1, 4)],
    },
    {
      name: 'moves an end on wrap padding to the cell before it',
      data: WIDE, options: { cols: 9 }, sel: at(0, 0, 0, 8), // `a` through the padding
      widths: [10], moved: [at(0, 0, 0, 7)],
    },
    {
      // A full buffer whose first row is the rest of a soft-wrapped line:
      // xterm's `getLine` reads past the last row onto it.
      name: 'keeps an edge past the end of its line on that line, at the end of a full buffer',
      data: `${'y'.repeat(70)}\r\n$ `, options: { cols: 20, rows: 3, scrollback: 1 }, sel: at(3, 0, 3, 15),
      widths: [10], moved: [at(3, 0, 3, 9)],
    },
    {
      // Already scrolled: the line that wraps when narrowed pushes `top` out,
      // and the trimmed marker's line -1 reads, through xterm's ring, the
      // newest line, which says `top` too.
      name: 'gives up when the line under an edge is trimmed off the top',
      data: `${'old\r\n'.repeat(5)}top\r\n${WRAPPING}\r\ntop`, options: { cols: 20, rows: 3, scrollback: 1 }, sel: at(0, 0, 0, 2),
      widths: [10], moved: [null],
    },
  ])('$name', async ({ data, options, sel, widths, moved }) => {
    const terminal = await terminalWith(data, options);
    expect(followThrough(terminal, sel, widths)).toEqual(moved);
  });

  it.each([
    { name: 'the cells no longer read as the selected text', data: '\x1b[1;2HXX\x1b[3;1H' },
    { name: 'the alternate buffer is active, whatever it shows', data: '\x1b[?1049h\x1b[Haaaa' },
  ])('gives up when $name', async ({ data }) => {
    const terminal = await terminalWith(`${WRAPPING}\r\n`, { cols: 20 });
    const anchor = anchorSelection(terminal, linewise(at(0, 0, 0, 3)))!; // `aaaa`
    await write(terminal, data);
    terminal.resize(10, terminal.rows);
    expect(followReflow(terminal, anchor)).toBeNull();
  });
});

describe('anchorSelection', () => {
  it('anchors nothing a resize cancels', async () => {
    const terminal = await terminalWith(`${WRAPPING}\r\n`, { cols: 20 });
    for (const over of [{ shape: 'block' }, { owner: 'program' }, { dragging: true }] as const) {
      expect(anchorSelection(terminal, { ...linewise(at(0, 5, 1, 3)), ...over })).toBeNull();
    }
    await write(terminal, '\x1b[?1049hfull screen');
    expect(anchorSelection(terminal, linewise(at(0, 0, 0, 3)))).toBeNull();
  });
});
