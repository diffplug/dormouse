import type { IBufferLine, Terminal } from '@xterm/xterm';
import type { Selection } from './mouse-selection';

// The screen the copy editor's tests and stories share.

/** A Claude Code reply as Ink hard-wraps it at 76 of 80 columns: prose, code,
 *  a URL split at the margin, and the input box's frame. */
export const CLAUDE_REPLY: readonly string[] = [
  '> why is selection-text.test.ts flaky on CI?',
  '',
  '⏺ The flake comes from a race between the PTY exit event and the final flush',
  '  of the output buffer. When the child exits before xterm has drained its',
  '  write queue, the last chunk is dropped and the assertion on the prompt',
  '  text fails intermittently.',
  '',
  '  The fix is to await the write callback before reading the buffer:',
  '',
  '    await new Promise<void>((resolve) => terminal.write(chunk, resolve));',
  '    const text = extractSelectionText(terminal, selection);',
  "    expect(text).toBe('user@dormouse:~$ ls');",
  '',
  '  I opened a draft with the change: https://github.com/diffplug/dormouse/pul',
  '  l/853/files#diff-7c1f3e9a2b8d4f6e0a5c7b9d1e3f5a7c9b1d3e5f',
  '',
  `╭${'─'.repeat(78)}╮`,
  `│ > ${' '.repeat(75)}│`,
  `╰${'─'.repeat(78)}╯`,
];

/** Twenty-nine cells: at 20 columns the line soft-wraps after `dddd `, and at
 *  19 before ` eeee`. */
export const WRAPPING = 'aaaa bbbb cccc dddd eeee ffff';

/** Just enough of an xterm `Terminal` over plain strings — one narrow cell
 *  per UTF-16 unit, `wrapped` rows marked as soft wraps — for the copy
 *  editor's and the selection's reads. */
export function fakeXterm(lines: readonly string[], { cols = 80, wrapped = [] }: { cols?: number; wrapped?: readonly number[] } = {}): Terminal {
  const getLine = (r: number) => {
    const text = lines[r];
    if (text === undefined) return undefined;
    return {
      length: cols,
      isWrapped: wrapped.includes(r),
      getCell: (c: number) => ({ getChars: () => text[c] ?? '', getWidth: () => 1 }),
      translateToString: (_trim?: boolean, start = 0, end = cols) => text.slice(start, end),
    };
  };
  return { cols, rows: 24, buffer: { active: { length: lines.length, getLine } } } as unknown as Terminal;
}

/** A buffer line of `[chars, width]` cells, a width-2 cell followed by its
 *  zero-width continuation, as xterm lays out wide characters. */
export function bufferLine(parts: ReadonlyArray<readonly [string, number]>): IBufferLine {
  const cells = parts.flatMap(([chars, width]) => [
    { getChars: () => chars, getWidth: () => width },
    ...Array.from({ length: width - 1 }, () => ({ getChars: () => '', getWidth: () => 0 })),
  ]);
  return { length: cells.length, isWrapped: false, getCell: (col: number) => cells[col] } as unknown as IBufferLine;
}

/** A finalized linewise selection, as mouse-up leaves one. */
export function finalizedSelection(over: Partial<Selection> = {}): Selection {
  return { startRow: 0, startCol: 0, endRow: 0, endCol: 0, shape: 'linewise', dragging: false, startedInScrollback: false, ...over };
}
