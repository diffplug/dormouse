import { describe, expect, it } from 'vitest';
import { readLogicalLineFromBuffer, type BufferLike } from './terminal-buffer-read';

// Fake buffer of fixed-width rows mimicking xterm: trailing cells blank-pad to
// `width`, a row can be flagged as a soft-wrapped continuation, and
// translateToString honors start/end columns.
function makeBuffer(rows: { text: string; wrapped?: boolean }[], width = 40): BufferLike {
  return {
    getLine(index: number) {
      const row = rows[index];
      if (row === undefined) return undefined;
      const padded = row.text.padEnd(width, ' ');
      return {
        isWrapped: row.wrapped ?? false,
        translateToString: (_trimRight?: boolean, startColumn = 0, endColumn?: number) =>
          padded.slice(startColumn, endColumn),
      };
    },
  };
}

describe('readLogicalLineFromBuffer', () => {
  it('reads a single unwrapped line up to the cursor', () => {
    const line = 'u@h dir % pnpm dev';
    const buffer = makeBuffer([{ text: line }]);
    expect(readLogicalLineFromBuffer(buffer, 0, line.length)?.trim()).toBe('u@h dir % pnpm dev');
  });

  it('excludes autosuggest ghost text rendered after the cursor', () => {
    // The user typed "pnpm dev"; ":website" is a greyed suggestion past the cursor.
    const buffer = makeBuffer([{ text: 'u@h dir % pnpm dev:website' }]);
    const cursor = 'u@h dir % pnpm dev'.length;
    expect(readLogicalLineFromBuffer(buffer, 0, cursor)?.trim()).toBe('u@h dir % pnpm dev');
  });

  it('joins soft-wrapped continuation rows up to the cursor', () => {
    const buffer = makeBuffer(
      [
        { text: 'u@h dir % aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, // fills the 40-col row
        { text: 'bbbb --flag', wrapped: true },
      ],
      40,
    );
    // Cursor at the end of the continuation row still yields the whole command.
    expect(readLogicalLineFromBuffer(buffer, 1, 'bbbb --flag'.length)?.trim()).toBe(
      'u@h dir % aaaaaaaaaaaaaaaaaaaaaaaaaaaaaabbbb --flag',
    );
  });

  it('walks up to the logical start when the cursor is on a wrapped row', () => {
    const buffer = makeBuffer(
      [
        { text: 'earlier output' },
        { text: 'u@h dir % first-half-of-a-very-long-cmd-' },
        { text: 'second-half', wrapped: true },
      ],
      40,
    );
    expect(readLogicalLineFromBuffer(buffer, 2, 'second-half'.length)?.startsWith('u@h dir % first-half')).toBe(true);
  });

  it('returns null when the row is out of range', () => {
    expect(readLogicalLineFromBuffer(makeBuffer([{ text: 'x' }]), 9, 0)).toBeNull();
  });
});
