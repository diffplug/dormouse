import { describe, expect, it } from 'vitest';
import { readLogicalLineFromBuffer, type BufferLike } from './terminal-buffer-read';

// Fake buffer of fixed-width rows mimicking xterm: trailing cells blank-pad to
// `width`, and a row can be flagged as a soft-wrapped continuation.
function makeBuffer(rows: { text: string; wrapped?: boolean }[], width = 40): BufferLike {
  return {
    getLine(index: number) {
      const row = rows[index];
      if (row === undefined) return undefined;
      return {
        isWrapped: row.wrapped ?? false,
        translateToString: (_trimRight?: boolean) => row.text.padEnd(width, ' '),
      };
    },
  };
}

describe('readLogicalLineFromBuffer', () => {
  it('reads a single unwrapped line', () => {
    const buffer = makeBuffer([{ text: 'u@h dir % pnpm dev' }]);
    expect(readLogicalLineFromBuffer(buffer, 0)?.trim()).toBe('u@h dir % pnpm dev');
  });

  it('joins soft-wrapped continuation rows', () => {
    const buffer = makeBuffer(
      [
        { text: 'u@h dir % aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }, // fills the 40-col row
        { text: 'bbbb --flag', wrapped: true },
      ],
      40,
    );
    // Cursor on the continuation row still yields the whole logical line.
    expect(readLogicalLineFromBuffer(buffer, 1)?.trim()).toBe(
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
    expect(readLogicalLineFromBuffer(buffer, 2)?.startsWith('u@h dir % first-half')).toBe(true);
  });

  it('returns null when the row is out of range', () => {
    expect(readLogicalLineFromBuffer(makeBuffer([{ text: 'x' }]), 9)).toBeNull();
  });
});
