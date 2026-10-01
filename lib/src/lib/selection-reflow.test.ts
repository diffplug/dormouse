// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { finalizedSelection } from './copy-text-fixtures';
import type { Selection } from './mouse-selection';
import { anchorSelection, followReflow } from './selection-reflow';

/** A finalized linewise selection follows its cells through a resize's reflow
 *  (docs/specs/mouse-and-clipboard.md §3.4). */

const live: Terminal[] = [];
afterEach(() => { for (const terminal of live.splice(0)) terminal.dispose(); });

async function terminalWith(data: string, options: { cols: number; rows?: number; scrollback?: number }): Promise<Terminal> {
  const terminal = new Terminal({ rows: 10, ...options, allowProposedApi: true });
  live.push(terminal);
  await new Promise<void>((resolve) => terminal.write(data, resolve));
  return terminal;
}

/** Anchor `sel`, resize to each width in turn, and follow it after each. */
function followThrough(terminal: Terminal, sel: Selection, widths: readonly number[]): (Selection | null)[] {
  return widths.map((cols) => {
    const anchor = anchorSelection(terminal, sel)!;
    terminal.resize(cols, terminal.rows);
    const moved = followReflow(terminal, sel, anchor);
    anchor.dispose();
    if (moved) sel = moved;
    return moved;
  });
}

const at = (startRow: number, startCol: number, endRow: number, endCol: number) => ({ startRow, startCol, endRow, endCol });

// Twenty-nine cells: at 20 columns the line soft-wraps after `dddd `.
const WRAPPING = 'aaaa bbbb cccc dddd eeee ffff';

describe('followReflow', () => {
  it('carries a selection across a soft wrap through narrower and wider widths', async () => {
    const terminal = await terminalWith(`${WRAPPING}\r\n`, { cols: 20 });
    const sel = finalizedSelection(at(0, 5, 1, 3)); // `bbbb` through `eeee`
    const [narrow, wide, back] = followThrough(terminal, sel, [10, 40, 20]);
    expect(narrow).toMatchObject(at(0, 5, 2, 3));
    expect(wide).toMatchObject(at(0, 5, 0, 23));
    expect(back).toEqual(sel);
  });

  it('shifts a selection on hard-wrapped lines below a line that reflows, keeping its direction', async () => {
    const terminal = await terminalWith(`${WRAPPING}\r\nfirst\r\nsecond\r\n`, { cols: 20 });
    const sel = finalizedSelection(at(3, 5, 2, 0)); // dragged up from `second` to `first`
    const [narrow, wide] = followThrough(terminal, sel, [10, 40]);
    expect(narrow).toMatchObject(at(4, 5, 3, 0));
    expect(wide).toMatchObject(at(2, 5, 1, 0));
  });

  it('skips the padding a wide character leaves when it wraps', async () => {
    // At 9 columns `中` cannot fit in the last cell, which xterm leaves blank.
    const terminal = await terminalWith('abcdefgh中文xyz\r\n', { cols: 9 });
    const throughWide = finalizedSelection(at(0, 7, 1, 2)); // `h` through `文`
    expect(followThrough(terminal, throughWide, [10, 9])).toMatchObject([at(0, 7, 1, 0), at(0, 7, 1, 2)]);
    // An edge on the padding comes back where the text resumes.
    const fromPadding = finalizedSelection(at(0, 8, 1, 4)); // the padding through `x`
    expect(followThrough(terminal, fromPadding, [10, 9])).toMatchObject([at(0, 8, 1, 2), at(1, 0, 1, 4)]);
    const toPadding = finalizedSelection(at(0, 0, 0, 8)); // `a` through the padding
    expect(followThrough(terminal, toPadding, [10])).toMatchObject([at(0, 0, 0, 7)]);
  });

  it('keeps an edge past the end of its line on that line, at the end of a full buffer', async () => {
    // Three rows and one of scrollback, full, its first row the rest of a
    // soft-wrapped line: xterm's `getLine` reads past the last row onto it.
    const terminal = await terminalWith(`${'y'.repeat(70)}\r\n$ `, { cols: 20, rows: 3, scrollback: 1 });
    expect(followThrough(terminal, finalizedSelection(at(3, 0, 3, 15)), [10])).toMatchObject([at(3, 0, 3, 9)]);
  });

  it('gives up when the line under an edge is trimmed off the top', async () => {
    // Three rows and one of scrollback, already scrolled: the line that wraps
    // when narrowed pushes `top` out, and the trimmed marker's line -1 reads,
    // through xterm's ring, the newest line, which says `top` too.
    const terminal = await terminalWith(`${'old\r\n'.repeat(5)}top\r\n${WRAPPING}\r\ntop`, { cols: 20, rows: 3, scrollback: 1 });
    expect(followThrough(terminal, finalizedSelection(at(0, 0, 0, 2)), [10])).toEqual([null]);
  });

  it('gives up when the cells no longer read as the selected text', async () => {
    const terminal = await terminalWith(`${WRAPPING}\r\n`, { cols: 20 });
    const sel = finalizedSelection(at(0, 5, 1, 3));
    const anchor = anchorSelection(terminal, sel)!;
    await new Promise<void>((resolve) => terminal.write('\x1b[1;7HXX\x1b[3;1H', resolve));
    terminal.resize(10, terminal.rows);
    expect(followReflow(terminal, sel, anchor)).toBeNull();
  });

  it('gives up once the alternate buffer is active, whatever it shows', async () => {
    const terminal = await terminalWith('abc\r\n', { cols: 20 });
    const sel = finalizedSelection(at(0, 0, 0, 2));
    const anchor = anchorSelection(terminal, sel)!;
    await new Promise<void>((resolve) => terminal.write('\x1b[?1049h\x1b[Habc', resolve));
    terminal.resize(10, terminal.rows);
    expect(followReflow(terminal, sel, anchor)).toBeNull();
  });
});

describe('anchorSelection', () => {
  it('anchors nothing a resize cancels', async () => {
    const terminal = await terminalWith(`${WRAPPING}\r\n`, { cols: 20 });
    for (const over of [{ shape: 'block' }, { owner: 'program' }, { dragging: true }] as const) {
      expect(anchorSelection(terminal, finalizedSelection({ ...at(0, 5, 1, 3), ...over }))).toBeNull();
    }
    await new Promise<void>((resolve) => terminal.write('\x1b[?1049hfull screen', resolve));
    expect(anchorSelection(terminal, finalizedSelection(at(0, 0, 0, 3)))).toBeNull();
  });
});
