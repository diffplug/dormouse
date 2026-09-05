import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMarker, Terminal } from '@xterm/xterm';

const mocks = vi.hoisted(() => ({
  getTerminalInstance: vi.fn<(id: string) => unknown>(),
}));

// Both `pin` and the `revealResolvedSource` it calls reach for the registry;
// stub the barrel so neither boots xterm.
vi.mock('../terminal-registry', () => ({ getTerminalInstance: mocks.getTerminalInstance }));

import { __resetMouseSelectionForTests, getMouseSelectionState } from '../mouse-selection';
import { FakePtyAdapter, setPlatform } from '../platform';
import { addPlainNote, addTerminalNote, clearAllNotepads, getNotes } from './notepad-store';
import { revealNoteSource } from './pin';
import type { RuntimeTerminalSource } from './types';

class FakeMarker {
  isDisposed = false;
  constructor(public line: number) {}
  dispose(): void {
    this.isDisposed = true;
    this.line = -1;
  }
}

const LINES = ['alpha one', 'bravo two', 'charlie three'];

/** Satisfies both `resolveTerminalSource` (buffer reads) and
 *  `revealResolvedSource` (viewport + scroll). */
function makeTerminal(
  lines: string[] = LINES,
  opts: { viewportY?: number; baseY?: number; type?: 'normal' | 'alternate' } = {},
) {
  const cols = Math.max(1, ...lines.map((line) => line.length));
  const scrollToLine = vi.fn<(line: number) => void>();
  const terminal = {
    cols,
    rows: 24,
    buffer: {
      active: {
        type: opts.type ?? ('normal' as const),
        baseY: opts.baseY ?? 0,
        viewportY: opts.viewportY ?? 0,
        cursorY: 0,
        length: lines.length,
        getLine: (y: number) => (lines[y] === undefined ? undefined : {
          translateToString: (_trim?: boolean, start = 0, end = cols) =>
            lines[y].padEnd(cols, ' ').slice(start, end),
        }),
      },
    },
    scrollToLine,
  };
  return { terminal: terminal as unknown as Terminal, scrollToLine };
}

/** A pin over `alpha one\nbravo`, the text `LINES` reads back for rows 0..1. */
function source(overrides: Partial<RuntimeTerminalSource> = {}): RuntimeTerminalSource {
  return {
    terminalId: 'term-1',
    startMarker: new FakeMarker(0) as unknown as IMarker,
    endMarker: new FakeMarker(1) as unknown as IMarker,
    startColumn: 0,
    endColumn: 4,
    shape: 'linewise',
    expectedRawText: 'alpha one\nbravo',
    ...overrides,
  };
}

/** The note whose pin every test below follows. */
function pinnedNote(src = source()): { noteId: string; source: RuntimeTerminalSource } {
  return { noteId: addTerminalNote('term-1', [{ text: 'alpha one\nbravo' }], src), source: src };
}

const markersOf = (src: RuntimeTerminalSource) =>
  [src.startMarker, src.endMarker] as unknown as FakeMarker[];

beforeEach(() => {
  clearAllNotepads();
  __resetMouseSelectionForTests();
  mocks.getTerminalInstance.mockReset();
  setPlatform(new FakePtyAdapter());
});

describe('revealNoteSource', () => {
  it('reveals the range and keeps the pin', () => {
    const { terminal, scrollToLine } = makeTerminal(LINES, { viewportY: 40, baseY: 40 });
    mocks.getTerminalInstance.mockReturnValue(terminal);
    const { noteId, source: src } = pinnedNote();

    expect(revealNoteSource('term-1', noteId)).toEqual({ ok: true });
    expect(scrollToLine).toHaveBeenCalledWith(0);
    expect(getMouseSelectionState('term-1').selection).toMatchObject({
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 4,
      dragging: false,
    });
    expect(getNotes('term-1')[0].source).toBe(src);
    expect(markersOf(src).every((marker) => !marker.isDisposed)).toBe(true);
  });

  it('reports a note that has no pin', () => {
    const noteId = addPlainNote('term-1', 'typed by hand');
    expect(revealNoteSource('term-1', noteId)).toEqual({ ok: false, reason: 'no-source' });
  });

  it('reports a note that is gone', () => {
    expect(revealNoteSource('term-1', 'missing')).toEqual({ ok: false, reason: 'no-source' });
  });

  it('drops the pin when the terminal instance is gone', () => {
    mocks.getTerminalInstance.mockReturnValue(null);
    const { noteId, source: src } = pinnedNote();

    expect(revealNoteSource('term-1', noteId)).toEqual({ ok: false, reason: 'no-terminal' });
    expect(getNotes('term-1')[0].source).toBeUndefined();
    // The markers belonged to that instance; dropping the pin releases them.
    expect(markersOf(src).every((marker) => marker.isDisposed)).toBe(true);
  });

  it('drops the pin when the markers are disposed', () => {
    mocks.getTerminalInstance.mockReturnValue(makeTerminal().terminal);
    const src = source();
    markersOf(src)[0].dispose();
    const { noteId } = pinnedNote(src);

    expect(revealNoteSource('term-1', noteId)).toEqual({ ok: false, reason: 'disposed' });
    expect(getNotes('term-1')[0].source).toBeUndefined();
  });

  it('keeps the pin while a full-screen program owns the buffer', () => {
    // The markers still name live normal-buffer rows; only the view is covered.
    mocks.getTerminalInstance.mockReturnValue(makeTerminal(LINES, { type: 'alternate' }).terminal);
    const { noteId, source: src } = pinnedNote();

    expect(revealNoteSource('term-1', noteId)).toEqual({ ok: false, reason: 'alternate-buffer' });
    expect(getNotes('term-1')[0].source).toBe(src);
    expect(markersOf(src).every((marker) => !marker.isDisposed)).toBe(true);
    expect(getMouseSelectionState('term-1').selection).toBeNull();
  });

  it('drops the pin when the rows are gone', () => {
    mocks.getTerminalInstance.mockReturnValue(makeTerminal(['alpha one']).terminal);
    const { noteId } = pinnedNote();

    expect(revealNoteSource('term-1', noteId)).toEqual({ ok: false, reason: 'missing-rows' });
    expect(getNotes('term-1')[0].source).toBeUndefined();
  });

  it('drops the pin when the rows read back differently', () => {
    mocks.getTerminalInstance.mockReturnValue(
      makeTerminal(['alpha one', 'BRAVO two', 'charlie three']).terminal,
    );
    const { noteId, source: src } = pinnedNote();

    expect(revealNoteSource('term-1', noteId)).toEqual({ ok: false, reason: 'mismatch' });
    expect(getNotes('term-1')[0].source).toBeUndefined();
    expect(markersOf(src).every((marker) => marker.isDisposed)).toBe(true);
    // The note itself survives every failure — only the link goes.
    expect(getNotes('term-1')[0].content).toEqual({
      kind: 'terminal',
      runs: [{ text: 'alpha one\nbravo' }],
    });
  });

  it('leaves the viewport alone when the range is already on screen', () => {
    const { terminal, scrollToLine } = makeTerminal(LINES, { viewportY: 0, baseY: 10 });
    mocks.getTerminalInstance.mockReturnValue(terminal);
    const { noteId } = pinnedNote();

    expect(revealNoteSource('term-1', noteId)).toEqual({ ok: true });
    expect(scrollToLine).not.toHaveBeenCalled();
  });
});
