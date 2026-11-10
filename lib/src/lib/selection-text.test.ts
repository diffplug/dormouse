import { describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { extractSelectionText } from './selection-text';
import type { Selection } from './mouse-selection';

function makeTerminal(lines: string[]): Terminal {
  const cols = Math.max(...lines.map((l) => l.length));
  const getLine = (r: number) => {
    const line = lines[r];
    if (line === undefined) return undefined;
    return {
      translateToString: (_trimRight?: boolean, start = 0, end = cols) => line.slice(start, end),
    } as unknown as ReturnType<Terminal['buffer']['active']['getLine']>;
  };
  return {
    cols,
    rows: lines.length,
    buffer: { active: { getLine } },
  } as unknown as Terminal;
}

function sel(overrides: Partial<Selection>): Selection {
  return {
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    shape: 'linewise',
    dragging: false,
    ...overrides,
  };
}

describe('extractSelectionText', () => {
  const t = makeTerminal([
    'The quick brown fox',
    'jumps over the lazy',
    'dog and runs away.',
  ]);

 it('single-row linewise', () => {
    const s = sel({ startRow: 0, startCol: 4, endRow: 0, endCol: 8 });
   expect(extractSelectionText(t, s)).toBe('quick');
  });

 it('multi-row linewise trims each end', () => {
    const s = sel({ startRow: 0, startCol: 10, endRow: 2, endCol: 2 });
   expect(extractSelectionText(t, s)).toBe('brown fox\njumps over the lazy\ndog');
  });

 it('reversed linewise (user dragged right-to-left)', () => {
    const s = sel({ startRow: 0, startCol: 8, endRow: 0, endCol: 4 });
   expect(extractSelectionText(t, s)).toBe('quick');
  });

  it('block shape extracts the rectangular slab', () => {
    // Columns 4..8 across all three rows
    const s = sel({ startRow: 0, startCol: 4, endRow: 2, endCol: 8, shape: 'block' });
    expect(extractSelectionText(t, s)).toBe('quick\ns ove\nand r');
  });
});
