import { describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
  autoBreak,
  computeScopes,
  nudge,
  render,
  stringCopyBuffer,
  terminalCopyBuffer,
  type CopyBuffer,
  type CopyFormat,
  type Span,
} from './copy-text';
import { CLAUDE_REPLY, fakeXterm } from './copy-text-fixtures';
import { extractSelectionText } from './selection-text';
import type { Selection } from './mouse-selection';

const CLAUDE = CLAUDE_REPLY;
const claude = stringCopyBuffer(CLAUDE, { cols: 80 });

const span = (r0: number, c0: number, r1: number, c1: number, block = false): Span => ({ start: { row: r0, col: c0 }, end: { row: r1, col: c1 }, block });
const text = (buf: CopyBuffer, s: Span, format: CopyFormat) => render(buf, s, { original: s, format }).text;

describe('copy-text formats', () => {
  const prose = span(2, 2, 5, 27);

  it('Auto joins a hard-wrapped paragraph and drops the reply bullet', () => {
    expect(text(claude, prose, 'auto')).toBe(
      'The flake comes from a race between the PTY exit event and the final flush of the output buffer. When the child exits before xterm has drained its write queue, the last chunk is dropped and the assertion on the prompt text fails intermittently.',
    );
  });

  it('Exact is the old Copy Raw: rows trimmed, indents kept', () => {
    const sel: Selection = { startRow: 2, startCol: 2, endRow: 5, endCol: 27, shape: 'linewise', dragging: false, startedInScrollback: false };
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
    const buf = stringCopyBuffer(['abcdefghij', 'klm'], { cols: 10, wrapped: [1] });
    expect(text(buf, span(0, 0, 1, 2), 'auto')).toBe('abcdefghijklm');
    expect(text(buf, span(0, 0, 1, 2), 'spaces')).toBe('abcdefghij klm');
  });

  it('never joins two short lines, however alike', () => {
    const buf = stringCopyBuffer(['Hello', 'World'], { cols: 80 });
    expect(text(buf, span(0, 0, 1, 4), 'auto')).toBe('Hello\nWorld');
  });

  it('keeps list items on their own lines', () => {
    const buf = stringCopyBuffer([
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
    expect(r.lines).toBe(2);
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
});

describe('copy-text scopes', () => {
  it('expands a clipped URL across the split, then to its paragraph', () => {
    const scopes = computeScopes(claude, span(13, 44, 14, 30));
    expect(scopes.map((s) => s.label)).toEqual(['As selected', 'Full URL', 'Paragraph']);
    expect(scopes[1].span).toEqual(span(13, 36, 14, 58));
    expect(scopes[2].span).toEqual(span(13, 2, 14, 58));
  });

  it('skips a scope that adds nothing', () => {
    const scopes = computeScopes(claude, span(2, 2, 5, 27));
    expect(scopes.map((s) => s.label)).toEqual(['As selected']);
  });

  it('names a path or a plain word the way the smart-token detector does', () => {
    const buf = stringCopyBuffer(['see ~/projects/dormouse/README.md and src/lib/x.ts too'], { cols: 80 });
    expect(computeScopes(buf, span(0, 8, 0, 20))[1].label).toBe('Full path');
    expect(computeScopes(buf, span(0, 42, 0, 46))[1].label).toBe('Whole words');
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
    const cells = [
      { chars: '中', width: 2 }, { chars: '', width: 0 },
      { chars: 'x', width: 1 }, { chars: '', width: 1 }, { chars: '', width: 1 },
    ];
    const line = {
      length: cells.length,
      isWrapped: false,
      getCell: (c: number) => (cells[c] ? { getChars: () => cells[c].chars, getWidth: () => cells[c].width } : undefined),
    };
    const terminal = { cols: 5, buffer: { active: { length: 1, getLine: () => line } } } as unknown as Terminal;
    const buf = terminalCopyBuffer(terminal);
    expect(buf.row(0).cells).toEqual(['中', '', 'x']);
    expect(text(buf, span(0, 1, 0, 2), 'exact')).toBe('x');
    expect(text(buf, span(0, 0, 0, 2), 'exact')).toBe('中x');
  });
});
