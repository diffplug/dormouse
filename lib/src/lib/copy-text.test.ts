import { describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
  autoBreak,
  computeScopes,
  nudge,
  render,
  terminalCopyBuffer,
  type CopyBuffer,
  type CopyFormat,
  type Span,
} from './copy-text';
import { bufferLine, CLAUDE_REPLY, fakeXterm, finalizedSelection, WRAPPING } from './copy-text-fixtures';
import { extractSelectionText } from './selection-text';

const CLAUDE = CLAUDE_REPLY;
/** A copy buffer over plain lines, through the real xterm cell reader. */
const lines = (rows: readonly string[], options: { cols: number; wrapped?: number[] }) => terminalCopyBuffer(fakeXterm(rows, options));
const claude = lines(CLAUDE, { cols: 80 });

const span = (r0: number, c0: number, r1: number, c1: number, block = false): Span => ({ start: { row: r0, col: c0 }, end: { row: r1, col: c1 }, block });
const text = (buf: CopyBuffer, s: Span, format: CopyFormat) => render(buf, s, { original: s, format }).text;
/** {@link WRAPPING} as xterm soft-wraps it at `cols`. */
const softWrapped = (cols: number) => lines([WRAPPING.slice(0, cols), WRAPPING.slice(cols)], { cols, wrapped: [1] });
/** `rows` as xterm reflows them into a narrower terminal: a row's text wider
 *  than `cols` continues onto soft-wrapped rows. */
function reflowed(rows: readonly string[], cols: number): CopyBuffer {
  const out: string[] = [];
  const wrapped: number[] = [];
  for (const row of rows) {
    const rowText = row.trimEnd();
    out.push(rowText.slice(0, cols));
    for (let c = cols; c < rowText.length; c += cols) {
      wrapped.push(out.length);
      out.push(rowText.slice(c, c + cols));
    }
  }
  return lines(out, { cols, wrapped });
}
/** {@link CLAUDE} in a pane narrowed to 60 columns: each reply row past the
 *  60th column wraps, so rows 2–8 are the first paragraph, 10–16 the code,
 *  and 18–20 the URL. */
const narrowed = reflowed(CLAUDE, 60);
/** A line whose wrap leaves a row of only blanks between its text. */
const blankWrap = lines(['intro', '', 'aaaa bbbb cccc dddd ', ' '.repeat(20), 'eeee ffff', '', 'outro'], { cols: 20, wrapped: [3, 4] });

describe('copy-text formats', () => {
  const prose = span(2, 2, 5, 27);

  it('Auto joins a hard-wrapped paragraph and drops the reply bullet', () => {
    expect(text(claude, prose, 'auto')).toBe(
      'The flake comes from a race between the PTY exit event and the final flush of the output buffer. When the child exits before xterm has drained its write queue, the last chunk is dropped and the assertion on the prompt text fails intermittently.',
    );
  });

  it('Exact is the old Copy Raw: rows trimmed, indents kept', () => {
    const sel = finalizedSelection({ startRow: 2, startCol: 2, endRow: 5, endCol: 27 });
    expect(text(claude, prose, 'exact')).toBe(extractSelectionText(fakeXterm(CLAUDE), sel));
    expect(text(claude, prose, 'exact').split('\n')[1]).toBe('  of the output buffer. When the child exits before xterm has drained its');
  });

  it('Spaces turns every break into one space; No breaks deletes them', () => {
    expect(text(claude, prose, 'spaces')).toBe(text(claude, prose, 'auto'));
    expect(text(claude, prose, 'joined')).toContain('final flushof the output');
  });

  it('Auto rejoins a token the program split at the margin with no space', () => {
    const url = span(13, 36, 14, 58);
    expect(text(claude, url, 'auto')).toBe('https://github.com/diffplug/dormouse/pull/853/files#diff-7c1f3e9a2b8d4f6e0a5c7b9d1e3f5a7c9b1d3e5f');
    expect(text(claude, url, 'spaces')).toContain('/pul l/853');
  });

  it('Auto keeps code lines, their relative indent, and paragraph breaks', () => {
    expect(text(claude, span(7, 2, 11, 44), 'auto')).toBe([
      'The fix is to await the write callback before reading the buffer:',
      '',
      '  await new Promise<void>((resolve) => terminal.write(chunk, resolve));',
      '  const text = extractSelectionText(terminal, selection);',
      "  expect(text).toBe('user@dormouse:~$ ls');",
    ].join('\n'));
  });

  it('drops frame-only rows and box sides', () => {
    expect(text(claude, span(15, 0, 18, 79), 'auto')).toBe('>');
  });

  it('joins a true soft wrap exactly, whatever the text', () => {
    const buf = lines(['abcdefghij', 'klm'], { cols: 10, wrapped: [1] });
    expect(text(buf, span(0, 0, 1, 2), 'auto')).toBe('abcdefghijklm');
    expect(text(buf, span(0, 0, 1, 2), 'spaces')).toBe('abcdefghij klm');
  });

  it('keeps the space either side of a soft wrap', () => {
    for (const cols of [20, 19]) {
      const buf = softWrapped(cols);
      const all = span(0, 0, 1, WRAPPING.length - cols - 1);
      expect(text(buf, all, 'auto')).toBe(WRAPPING);
      expect(text(buf, all, 'joined')).toBe(WRAPPING);
      expect(text(buf, all, 'spaces')).toBe(WRAPPING);
      expect(text(buf, all, 'exact')).toBe(`aaaa bbbb cccc dddd\n${cols === 20 ? '' : ' '}eeee ffff`);
    }
    // Mid-line, the space the next row starts with is no leading whitespace.
    expect(render(softWrapped(19), span(0, 0, 1, 9), { original: span(0, 0, 1, 9), format: 'auto' }).pieces).not.toContainEqual(expect.objectContaining({ lead: true }));
    // A block slab's rows end at its edge, not at the wrap.
    expect(text(softWrapped(20), span(0, 2, 1, 4, true), 'joined')).toBe('aaee');
  });

  it('reads a reply the terminal narrowed as it reads the original', () => {
    expect(text(narrowed, span(2, 2, 8, 27), 'auto')).toBe(text(claude, prose, 'auto'));
    expect(text(narrowed, span(10, 2, 16, 44), 'auto')).toBe(text(claude, span(7, 2, 11, 44), 'auto'));
    expect(text(narrowed, span(18, 36, 20, 58), 'auto')).toBe(text(claude, span(13, 36, 14, 58), 'auto'));
    expect(text(narrowed, span(2, 2, 4, 10), 'exact')).toBe('The flake comes from a race between the PTY exit event and\n the final flush\n  of the ou');
  });

  it('reads a blank row a soft wrap continues as part of its line', () => {
    const all = span(2, 0, 4, 8);
    const line = `aaaa bbbb cccc dddd ${' '.repeat(20)}eeee ffff`;
    expect(text(blankWrap, all, 'auto')).toBe(line);
    expect(text(blankWrap, all, 'joined')).toBe(line);
    expect(text(blankWrap, all, 'exact')).toBe('aaaa bbbb cccc dddd\n\neeee ffff');
  });

  it('trims a line’s trailing blanks, however many rows they wrap onto', () => {
    const buf = lines(['aaaa bbbb cccc dddd ', ' '.repeat(20), 'eeee'], { cols: 20, wrapped: [1] });
    expect(text(buf, span(0, 0, 2, 3), 'joined')).toBe('aaaa bbbb cccc ddddeeee');
    expect(text(buf, span(0, 0, 2, 3), 'exact')).toBe('aaaa bbbb cccc dddd\n\neeee');
  });

  it('finds the shared indent without the rows a soft wrap continues', () => {
    const code = reflowed(['    const a = 1;', '    const message = "a long string that wraps";', '    const b = 2;'], 30);
    expect(text(code, span(0, 0, 3, 15), 'auto')).toBe('const a = 1;\nconst message = "a long string that wraps";\nconst b = 2;');
    expect(text(code, span(0, 0, 3, 15), 'exact')).toBe('    const a = 1;\n    const message = "a long st\nring that wraps";\n    const b = 2;');
    // Nor does a scope starting where a soft wrap fell keep the blank there.
    const buf = lines([WRAPPING.slice(0, 19), WRAPPING.slice(19), '', 'next'], { cols: 19, wrapped: [1] });
    expect(text(buf, span(1, 0, 3, 3), 'auto')).toBe('eeee ffff\n\nnext');
    expect(text(buf, span(1, 0, 3, 3), 'exact')).toBe(' eeee ffff\n\nnext');
  });

  it('joins a paragraph wrapped far narrower than the terminal', () => {
    const buf = lines([
      'The flake comes from a race between the PTY exit',
      'event and the final flush of the output buffer.',
      'When the child exits before xterm has drained its',
      'write queue, the last chunk is dropped.',
    ], { cols: 200 });
    expect(text(buf, span(0, 0, 3, 38), 'auto')).toBe(
      'The flake comes from a race between the PTY exit event and the final flush of the output buffer. When the child exits before xterm has drained its write queue, the last chunk is dropped.',
    );
  });

  it('never joins two short lines, however alike', () => {
    const buf = lines(['Hello', 'World'], { cols: 80 });
    expect(text(buf, span(0, 0, 1, 4), 'auto')).toBe('Hello\nWorld');
  });

  it('keeps list items on their own lines', () => {
    const buf = lines([
      '- the first item wraps because it is long enough to reach past the margin',
      '  of the pane',
      '- the second item',
    ], { cols: 80 });
    expect(text(buf, span(0, 0, 2, 16), 'auto')).toBe('- the first item wraps because it is long enough to reach past the margin of the pane\n- the second item');
  });

  it('reads a block slab exactly under Auto', () => {
    const block = span(2, 2, 4, 20, true);
    expect(text(claude, block, 'auto')).toBe(text(claude, block, 'exact'));
    expect(text(claude, block, 'exact').split('\n')).toEqual(['The flake comes fro', 'of the output buffe', 'write queue, the la']);
  });

  it('applies an override to one break and reports the format’s own decisions', () => {
    const r = render(claude, prose, { original: prose, format: 'auto', overrides: { 1: 'keep' } });
    const breaks = r.pieces.flatMap((p) => (p.t === 'break' ? [[p.auto, p.kind]] : []));
    expect(breaks).toEqual([['space', 'space'], ['space', 'keep'], ['space', 'space']]);
    expect(r.text.split('\n')).toHaveLength(2);
    expect(r.text.split('\n')[1]).toBe('write queue, the last chunk is dropped and the assertion on the prompt text fails intermittently.');
  });

  it('marks cells outside the dragged selection as added', () => {
    const grown = span(13, 36, 14, 58);
    const r = render(claude, grown, { original: span(13, 44, 14, 30), format: 'auto' });
    const added = r.pieces.filter((p) => p.t === 'text' && p.added).map((p) => p.t === 'text' ? p.text : '');
    expect(added).toEqual(['https://', '4f6e0a5c7b9d1e3f5a7c9b1d3e5f']);
  });
});

describe('copy-text autoBreak', () => {
  it('judges each break of the reply', () => {
    expect([2, 3, 4, 5].map((r) => autoBreak(claude, r))).toEqual(['space', 'space', 'space', 'keep']);
    expect([9, 10].map((r) => autoBreak(claude, r))).toEqual(['keep', 'keep']);
    expect(autoBreak(claude, 13)).toBe('none');
  });

  it('judges the lines a soft wrap joins, not its rows', () => {
    // Each wrapped reply row ends on a short continuation row; the next starts at the hanging indent.
    expect([2, 3, 4, 5, 6, 7, 8].map((r) => autoBreak(narrowed, r))).toEqual(['none', 'space', 'none', 'space', 'none', 'space', 'keep']);
    // The second line, wider than the pane, still ends where the next word would have fit.
    const typed = reflowed([
      'The flake comes from a race between the PTY exit event and the final flush of',
      'the output buffer, and this line ends early, as typed by hand.',
      'Then the next.',
    ], 60);
    expect([1, 3].map((r) => autoBreak(typed, r))).toEqual(['space', 'keep']);
  });
});

describe('copy-text scopes', () => {
  it('expands a clipped URL across the split, then to its paragraph', () => {
    const scopes = computeScopes(claude, span(13, 44, 14, 30));
    expect(scopes.map((s) => s.label)).toEqual(['As selected', 'Full URL', 'Paragraph']);
    expect(scopes[1].span).toEqual(span(13, 36, 14, 58));
    expect(scopes[2].span).toEqual(span(13, 2, 14, 58));
  });

  it('grows a split URL from either side to its real end and start', () => {
    for (const sel of [span(13, 50, 13, 60), span(14, 10, 14, 20)]) {
      expect(computeScopes(claude, sel)[1]).toEqual({ label: 'Full URL', span: span(13, 36, 14, 58) });
    }
    const url = 'see https://github.com/diffplug/dormouse/pull/853/files ok';
    const soft = lines([url.slice(0, 30), url.slice(30)], { cols: 30, wrapped: [1] });
    for (const sel of [span(0, 10, 0, 12), span(1, 5, 1, 8)]) {
      expect(computeScopes(soft, sel)[1]).toEqual({ label: 'Full URL', span: span(0, 4, 1, 24) });
    }
    // Across a soft wrap and then the program's own split.
    expect(computeScopes(narrowed, span(18, 50, 18, 55))[1]).toEqual({ label: 'Full URL', span: span(18, 36, 20, 58) });
  });

  it('bounds a paragraph by lines, not by a blank row a soft wrap continues', () => {
    const scopes = computeScopes(blankWrap, span(4, 0, 4, 1));
    expect(scopes.map((s) => s.label)).toEqual(['As selected', 'Whole words', 'Paragraph']);
    expect(scopes[2].span).toEqual(span(2, 0, 4, 8));
  });

  it('skips a scope that adds nothing', () => {
    const scopes = computeScopes(claude, span(2, 2, 5, 27));
    expect(scopes.map((s) => s.label)).toEqual(['As selected']);
  });

  it('names a path or a plain word the way the smart-token detector does', () => {
    const buf = lines(['see ~/projects/dormouse/README.md and src/lib/x.ts too'], { cols: 80 });
    expect(computeScopes(buf, span(0, 8, 0, 20))[1].label).toBe('Full path');
    expect(computeScopes(buf, span(0, 42, 0, 46))[1].label).toBe('Whole words');
  });

  it('grows nothing from an edge resting on a blank', () => {
    // Row 2 col 22 is the space after "from"; the end grows over "race".
    expect(computeScopes(claude, span(2, 22, 2, 27))[1].span).toMatchObject({ start: { row: 2, col: 22 }, end: { row: 2, col: 28 } });
  });

  it('grows a word to a soft wrap, never across the space there', () => {
    const buf = softWrapped(20);
    expect(computeScopes(buf, span(0, 16, 0, 17))[1].span).toEqual(span(0, 15, 0, 18));
    expect(computeScopes(buf, span(1, 1, 1, 2))[1].span).toEqual(span(1, 0, 1, 3));
    // The space is the continuation's first cell, inside the indent of its line.
    const indented = reflowed([`  ${WRAPPING}`], 21);
    expect(computeScopes(indented, span(0, 18, 0, 19))[1].span).toEqual(span(0, 17, 0, 20));
    expect(computeScopes(indented, span(1, 2, 1, 3))[1].span).toEqual(span(1, 1, 1, 4));
  });

  it('names a growth by its grown edge', () => {
    expect(computeScopes(claude, span(2, 27, 3, 10))[1].label).toBe('Whole words');
  });

  it('gives a block slab no other scope', () => {
    expect(computeScopes(claude, span(2, 2, 4, 20, true))).toHaveLength(1);
  });
});

describe('copy-text nudge', () => {
  it('moves an end to the next or previous word end', () => {
    expect(nudge(claude, { row: 2, col: 10 }, 1, 'end')).toEqual({ row: 2, col: 16 });
    expect(nudge(claude, { row: 2, col: 16 }, -1, 'end')).toEqual({ row: 2, col: 10 });
    expect(nudge(claude, { row: 2, col: 7 }, 1, 'end')).toEqual({ row: 2, col: 10 });
  });

  it('moves a start to the previous or next word start, across rows', () => {
    expect(nudge(claude, { row: 3, col: 2 }, -1, 'start')).toEqual({ row: 2, col: 71 });
    expect(nudge(claude, { row: 2, col: 71 }, 1, 'start')).toEqual({ row: 3, col: 2 });
  });

  it('snaps a mid-word start to that word first', () => {
    expect(nudge(claude, { row: 2, col: 9 }, -1, 'start')).toEqual({ row: 2, col: 6 });
  });
});

describe('copy-text terminalCopyBuffer', () => {
  it('maps wide characters through their continuation cells', () => {
    const terminal = { cols: 5, buffer: { active: { length: 1, getLine: () => bufferLine([['中', 2], ['x', 1]]) } } } as unknown as Terminal;
    const buf = terminalCopyBuffer(terminal);
    expect(buf.row(0).cells).toEqual(['中', '', 'x']);
    expect(text(buf, span(0, 1, 0, 2), 'exact')).toBe('x');
    expect(text(buf, span(0, 0, 0, 2), 'exact')).toBe('中x');
  });

  it('drops the blank a wide character leaves when it wraps', () => {
    const rows = [bufferLine([['a', 1], ['', 1]]), { ...bufferLine([['中', 2]]), isWrapped: true }];
    const terminal = { cols: 2, buffer: { active: { length: 2, getLine: (r: number) => rows[r] } } } as unknown as Terminal;
    expect(text(terminalCopyBuffer(terminal), span(0, 0, 1, 1), 'auto')).toBe('a中');
  });
});
