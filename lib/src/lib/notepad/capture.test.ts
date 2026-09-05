/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMarker, Terminal } from '@xterm/xterm';

const mocks = vi.hoisted(() => ({
  getTerminalInstance: vi.fn<(id: string) => unknown>(),
}));

// The registry barrel drags in the whole terminal lifecycle; capture only needs
// the one lookup, so stub it rather than boot xterm here.
vi.mock('../terminal-registry', () => ({ getTerminalInstance: mocks.getTerminalInstance }));

import { __resetMouseSelectionForTests, setSelection, type Selection } from '../mouse-selection';
import { FakePtyAdapter, setPlatform } from '../platform';
import { hasNotepadArchive } from './archive-service';
import { addSelectionToNotepad, isNotepadChordBound } from './capture';
import { clearAllNotepads, getNotes } from './notepad-store';

class FakeMarker {
  isDisposed = false;
  constructor(public line: number) {}
  dispose(): void {
    this.isDisposed = true;
    this.line = -1;
  }
}

/** A terminal made of plain unstyled rows — enough for both the rich walk
 *  (cells) and the raw read (`translateToString`) to agree. */
function makeTerminal(lines: string[], opts: { type?: 'normal' | 'alternate' } = {}): Terminal {
  const cols = Math.max(1, ...lines.map((line) => line.length));
  const cell = (ch: string) => ({
    getChars: () => ch,
    getWidth: () => 1,
    isBold: () => 0,
    isItalic: () => 0,
    isInverse: () => 0,
    isFgDefault: () => true,
    isFgPalette: () => false,
    isFgRGB: () => false,
    getFgColor: () => 0,
    isBgDefault: () => true,
    isBgPalette: () => false,
    isBgRGB: () => false,
    getBgColor: () => 0,
  });
  const getLine = (y: number) => {
    if (lines[y] === undefined) return undefined;
    const padded = lines[y].padEnd(cols, ' ');
    return {
      isWrapped: false,
      length: cols,
      getCell: (x: number) => (x < cols ? cell(padded[x]) : undefined),
      translateToString: (_trim?: boolean, start = 0, end = cols) => padded.slice(start, end),
    };
  };
  return {
    cols,
    options: { drawBoldTextInBrightColors: true },
    buffer: {
      active: {
        type: opts.type ?? 'normal',
        baseY: 0,
        cursorY: 0,
        length: lines.length,
        getLine,
      },
    },
    registerMarker: (offset = 0) => new FakeMarker(offset) as unknown as IMarker,
  } as unknown as Terminal;
}

function sel(overrides: Partial<Selection> = {}): Selection {
  return {
    startRow: 0,
    startCol: 0,
    endRow: 1,
    endCol: 4,
    shape: 'linewise',
    dragging: false,
    startedInScrollback: false,
    ...overrides,
  };
}

const LINES = ['alpha one', 'bravo two'];

beforeEach(() => {
  clearAllNotepads();
  __resetMouseSelectionForTests();
  mocks.getTerminalInstance.mockReset();
  setPlatform(new FakePtyAdapter());
});

describe('addSelectionToNotepad', () => {
  it('captures the finalized selection as a rich note pinned to its source', () => {
    mocks.getTerminalInstance.mockReturnValue(makeTerminal(LINES));
    setSelection('term-1', sel());

    expect(addSelectionToNotepad('term-1')).toBe(true);

    // The Surface id of a terminal Surface is its terminal id, so the note
    // lands under the same key the selection came from.
    const notes = getNotes('term-1');
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toEqual({ kind: 'terminal', runs: [{ text: 'alpha one\nbravo' }] });
    expect(notes[0].source).toMatchObject({
      terminalId: 'term-1',
      startColumn: 0,
      endColumn: 4,
      shape: 'linewise',
      expectedRawText: 'alpha one\nbravo',
    });
  });

  it('leaves the notepad closed and captures again on a second call', () => {
    mocks.getTerminalInstance.mockReturnValue(makeTerminal(LINES));
    setSelection('term-1', sel());

    addSelectionToNotepad('term-1');
    addSelectionToNotepad('term-1');

    expect(getNotes('term-1')).toHaveLength(2);
  });

  it('captures with no pin on the alternate buffer', () => {
    mocks.getTerminalInstance.mockReturnValue(makeTerminal(LINES, { type: 'alternate' }));
    setSelection('term-1', sel());

    expect(addSelectionToNotepad('term-1')).toBe(true);
    expect(getNotes('term-1')[0].source).toBeUndefined();
  });

  it('normalizes a reversed selection', () => {
    mocks.getTerminalInstance.mockReturnValue(makeTerminal(LINES));
    setSelection('term-1', sel({ startRow: 1, startCol: 4, endRow: 0, endCol: 0 }));

    expect(addSelectionToNotepad('term-1')).toBe(true);
    expect(getNotes('term-1')[0].source).toMatchObject({ startColumn: 0, endColumn: 4 });
  });

  it('does nothing without a selection', () => {
    mocks.getTerminalInstance.mockReturnValue(makeTerminal(LINES));

    expect(addSelectionToNotepad('term-1')).toBe(false);
    expect(getNotes('term-1')).toHaveLength(0);
  });

  it('does nothing mid-drag', () => {
    mocks.getTerminalInstance.mockReturnValue(makeTerminal(LINES));
    setSelection('term-1', sel({ dragging: true }));

    expect(addSelectionToNotepad('term-1')).toBe(false);
    expect(getNotes('term-1')).toHaveLength(0);
  });

  it('does nothing when the terminal instance is gone', () => {
    mocks.getTerminalInstance.mockReturnValue(null);
    setSelection('term-1', sel());

    expect(addSelectionToNotepad('term-1')).toBe(false);
    expect(getNotes('term-1')).toHaveLength(0);
  });
});

describe('isNotepadChordBound', () => {
  it('binds the chord on a host that has a notepad and has not ceded it', () => {
    const adapter = new FakePtyAdapter();
    setPlatform(adapter);
    expect(hasNotepadArchive()).toBe(true);
    expect(isNotepadChordBound()).toBe(true);

    // The website demo keeps the button and binds no chord.
    (adapter as { browserReservesNotepadChord?: boolean }).browserReservesNotepadChord = true;
    expect(hasNotepadArchive()).toBe(true);
    expect(isNotepadChordBound()).toBe(false);
  });

  it('binds nothing on a host with no notepad', () => {
    const adapter = new FakePtyAdapter();
    (adapter as { notepadArchive?: unknown }).notepadArchive = undefined;
    setPlatform(adapter);

    expect(hasNotepadArchive()).toBe(false);
    expect(isNotepadChordBound()).toBe(false);
  });
});
