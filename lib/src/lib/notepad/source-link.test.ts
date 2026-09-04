import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMarker } from '@xterm/xterm';
import type { Selection } from '../mouse-selection';
import type { RuntimeTerminalSource } from './types';

const mocks = vi.hoisted(() => ({
  getTerminalInstance: vi.fn<(id: string) => unknown>(),
}));

// The registry barrel drags in the whole terminal lifecycle; only
// `revealResolvedSource` needs it, so stub it rather than boot xterm here.
vi.mock('../terminal-registry', () => ({ getTerminalInstance: mocks.getTerminalInstance }));

import { getMouseSelectionState, setSelection } from '../mouse-selection';
import { extractSelectionText } from '../selection-text';
import {
  disposeTerminalSource,
  registerTerminalSource,
  resolveTerminalSource,
  revealResolvedSource,
  type SourceTerminalLike,
} from './source-link';

class FakeMarker {
  isDisposed = false;
  constructor(public line: number) {}
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    // xterm reports -1 once a marker is gone.
    this.line = -1;
  }
}

const asMarker = (marker: FakeMarker) => marker as unknown as IMarker;

interface FakeTerminalOptions {
  type?: 'normal' | 'alternate';
  baseY?: number;
  cursorY?: number;
  cols?: number;
  /** Override marker creation to exercise the failure paths. */
  registerMarker?: (offset: number) => IMarker | undefined;
}

interface FakeTerminal {
  terminal: SourceTerminalLike;
  markers: FakeMarker[];
}

function makeTerminal(lines: string[], opts: FakeTerminalOptions = {}): FakeTerminal {
  const cols = opts.cols ?? Math.max(1, ...lines.map((l) => l.length));
  const baseY = opts.baseY ?? 0;
  const cursorY = opts.cursorY ?? 0;
  const markers: FakeMarker[] = [];
  const terminal: SourceTerminalLike = {
    cols,
    buffer: {
      active: {
        type: opts.type ?? 'normal',
        baseY,
        cursorY,
        length: lines.length,
        getLine: (y: number) => (lines[y] === undefined ? undefined : {
          translateToString: (_trim?: boolean, start = 0, end = cols) => lines[y].slice(start, end),
        }),
      },
    },
    registerMarker: (offset = 0) => {
      if (opts.registerMarker) return opts.registerMarker(offset);
      const marker = new FakeMarker(baseY + cursorY + offset);
      markers.push(marker);
      return asMarker(marker);
    },
  };
  return { terminal, markers };
}

function sel(overrides: Partial<Selection>): Selection {
  return {
    startRow: 0,
    startCol: 0,
    endRow: 0,
    endCol: 0,
    shape: 'linewise',
    dragging: false,
    startedInScrollback: false,
    ...overrides,
  };
}

/** Register the way a capture does: the raw text is whatever the buffer reads now. */
function capture(fake: FakeTerminal, selection: Selection, id = 't1'): RuntimeTerminalSource {
  const raw = extractSelectionText(fake.terminal as never, selection);
  const source = registerTerminalSource(fake.terminal, id, selection, raw);
  if (!source) throw new Error('expected a source');
  return source;
}

const LINES = ['alpha one', 'bravo two', 'charlie three'];

describe('registerTerminalSource', () => {
  it('pins the normalized endpoints with cursor-relative markers', () => {
    // baseY 5 + cursorY 2 puts the cursor at absolute row 7, so a capture of
    // rows 2..4 has to register negative offsets to reach back into scrollback.
    const fake = makeTerminal(['a', 'b', 'alpha', 'bravo', 'charlie', 'd', 'e', 'f'], {
      baseY: 5,
      cursorY: 2,
    });
    const source = capture(fake, sel({ startRow: 2, startCol: 1, endRow: 4, endCol: 3 }));

    expect(source.terminalId).toBe('t1');
    expect(source.startMarker.line).toBe(2);
    expect(source.endMarker.line).toBe(4);
    expect(source.startColumn).toBe(1);
    expect(source.endColumn).toBe(3);
    expect(source.shape).toBe('linewise');
    expect(source.expectedRawText).toBe('lpha\nbravo\nchar');
  });

  it('normalizes a reversed selection before pinning it', () => {
    const fake = makeTerminal(LINES);
    const forward = sel({ startRow: 0, startCol: 2, endRow: 2, endCol: 6 });
    const reversed = sel({ startRow: 2, startCol: 6, endRow: 0, endCol: 2 });
    const source = capture(fake, reversed);

    expect(source.startMarker.line).toBe(0);
    expect(source.endMarker.line).toBe(2);
    expect(source.startColumn).toBe(2);
    expect(source.endColumn).toBe(6);
    expect(source.expectedRawText).toBe(extractSelectionText(fake.terminal as never, forward));
  });

  it('keeps a block shape', () => {
    const fake = makeTerminal(LINES);
    const source = capture(fake, sel({ startRow: 0, startCol: 2, endRow: 2, endCol: 5, shape: 'block' }));
    expect(source.shape).toBe('block');
    expect(source.expectedRawText).toBe('pha\navo\narli');
  });

  it('refuses an alternate-buffer capture and registers nothing', () => {
    const fake = makeTerminal(LINES, { type: 'alternate' });
    const selection = sel({ startRow: 0, startCol: 0, endRow: 1, endCol: 4 });
    expect(registerTerminalSource(fake.terminal, 't1', selection, 'alpha')).toBeNull();
    expect(fake.markers).toHaveLength(0);
  });

  it('gives up and disposes the first marker when the second cannot be made', () => {
    const made: FakeMarker[] = [];
    const fake = makeTerminal(LINES, {
      registerMarker: (offset) => {
        if (made.length > 0) return undefined;
        const marker = new FakeMarker(offset);
        made.push(marker);
        return asMarker(marker);
      },
    });
    const selection = sel({ startRow: 0, startCol: 0, endRow: 2, endCol: 4 });

    expect(registerTerminalSource(fake.terminal, 't1', selection, 'x')).toBeNull();
    expect(made[0].isDisposed).toBe(true);
  });

  it('rejects a marker that arrives already disposed', () => {
    const dead = new FakeMarker(0);
    dead.dispose();
    const fake = makeTerminal(LINES, { registerMarker: () => asMarker(dead) });
    const selection = sel({ startRow: 0, startCol: 0, endRow: 0, endCol: 4 });
    expect(registerTerminalSource(fake.terminal, 't1', selection, 'alpha')).toBeNull();
  });
});

describe('resolveTerminalSource', () => {
  it('rebuilds the range and reports it as a finalized selection', () => {
    const fake = makeTerminal(LINES, { baseY: 2 });
    const source = capture(fake, sel({ startRow: 1, startCol: 2, endRow: 2, endCol: 6 }));

    const result = resolveTerminalSource(fake.terminal, source);
    expect(result).toEqual({
      ok: true,
      selection: {
        startRow: 1,
        startCol: 2,
        endRow: 2,
        endCol: 6,
        shape: 'linewise',
        dragging: false,
        // Row 1 sits above baseY 2, so the range starts in scrollback.
        startedInScrollback: true,
      },
    });
  });

  it('follows the markers when the buffer has scrolled', () => {
    const fake = makeTerminal(['x', 'alpha one', 'bravo two'], { baseY: 0 });
    const source = capture(fake, sel({ startRow: 1, startCol: 0, endRow: 1, endCol: 4 }));
    // Scrollback trimming shifts every line up by one; the markers move with it.
    const scrolled = makeTerminal(['alpha one', 'bravo two']);
    (source.startMarker as unknown as FakeMarker).line = 0;
    (source.endMarker as unknown as FakeMarker).line = 0;

    expect(resolveTerminalSource(scrolled.terminal, source)).toEqual({
      ok: true,
      selection: expect.objectContaining({ startRow: 0, endRow: 0, startedInScrollback: false }),
    });
  });

  it('reports a disposed marker', () => {
    const fake = makeTerminal(LINES);
    const source = capture(fake, sel({ startRow: 0, startCol: 0, endRow: 1, endCol: 4 }));
    disposeTerminalSource(source);

    expect(resolveTerminalSource(fake.terminal, source)).toEqual({ ok: false, reason: 'disposed' });
  });

  it('reports rows the buffer no longer has', () => {
    const fake = makeTerminal(LINES);
    const source = capture(fake, sel({ startRow: 0, startCol: 0, endRow: 2, endCol: 4 }));
    // The terminal was cleared; the markers still name rows past its end.
    const shrunk = makeTerminal(['alpha one']);

    expect(resolveTerminalSource(shrunk.terminal, source)).toEqual({
      ok: false,
      reason: 'missing-rows',
    });
  });

  it('reports a text mismatch when the rows were overwritten', () => {
    const fake = makeTerminal(LINES);
    const source = capture(fake, sel({ startRow: 0, startCol: 0, endRow: 1, endCol: 8 }));
    const rewritten = makeTerminal(['alpha one', 'BRAVO two', 'charlie three']);

    expect(resolveTerminalSource(rewritten.terminal, source)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('still resolves after a resize that did not reflow the captured rows', () => {
    const narrow = makeTerminal(LINES, { cols: 13 });
    const source = capture(narrow, sel({ startRow: 0, startCol: 0, endRow: 2, endCol: 12 }));
    const wide = makeTerminal(LINES, { cols: 40 });

    expect(resolveTerminalSource(wide.terminal, source)).toMatchObject({ ok: true });
  });

  it('refuses when a resize rewrapped the captured text across different rows', () => {
    const narrow = makeTerminal(['alpha one br', 'avo two'], { cols: 12 });
    const source = capture(narrow, sel({ startRow: 0, startCol: 0, endRow: 1, endCol: 6 }));
    expect(source.expectedRawText).toBe('alpha one br\navo two');

    // Same characters, redistributed by a wider terminal: the equality check is
    // what stops a pin from navigating to plausible-looking wrong output.
    const wide = makeTerminal(['alpha one bravo two', ''], { cols: 19 });
    expect(resolveTerminalSource(wide.terminal, source)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('refuses while the alternate buffer is active', () => {
    const fake = makeTerminal(LINES);
    const source = capture(fake, sel({ startRow: 0, startCol: 0, endRow: 2, endCol: 4 }));
    const alt = makeTerminal(['full screen app'], { type: 'alternate' });

    expect(resolveTerminalSource(alt.terminal, source).ok).toBe(false);
  });
});

describe('disposeTerminalSource', () => {
  it('releases both markers and is safe to repeat', () => {
    const fake = makeTerminal(LINES);
    const source = capture(fake, sel({ startRow: 0, startCol: 0, endRow: 2, endCol: 4 }));

    disposeTerminalSource(source);
    disposeTerminalSource(source);

    expect(source.startMarker.isDisposed).toBe(true);
    expect(source.endMarker.isDisposed).toBe(true);
  });
});

describe('revealResolvedSource', () => {
  const scrollToLine = vi.fn<(line: number) => void>();

  function liveTerminal(opts: { viewportY: number; baseY: number; rows: number }) {
    return {
      rows: opts.rows,
      buffer: { active: { viewportY: opts.viewportY, baseY: opts.baseY } },
      scrollToLine,
    };
  }

  beforeEach(() => {
    scrollToLine.mockClear();
    mocks.getTerminalInstance.mockReset();
    setSelection('reveal', null);
  });

  it('scrolls an off-screen range into view and sets the selection', () => {
    mocks.getTerminalInstance.mockReturnValue(liveTerminal({ viewportY: 100, baseY: 100, rows: 24 }));
    const selection = sel({ startRow: 8, startCol: 0, endRow: 9, endCol: 4 });

    revealResolvedSource('reveal', selection);

    expect(scrollToLine).toHaveBeenCalledWith(8);
    expect(getMouseSelectionState('reveal').selection).toBe(selection);
  });

  it('leaves the viewport alone when the range is already on screen', () => {
    mocks.getTerminalInstance.mockReturnValue(liveTerminal({ viewportY: 0, baseY: 40, rows: 24 }));
    revealResolvedSource('reveal', sel({ startRow: 3, startCol: 0, endRow: 3, endCol: 4 }));

    expect(scrollToLine).not.toHaveBeenCalled();
    expect(getMouseSelectionState('reveal').selection).not.toBeNull();
  });

  it('clamps the scroll target to the last scrollable line', () => {
    mocks.getTerminalInstance.mockReturnValue(liveTerminal({ viewportY: 0, baseY: 10, rows: 5 }));
    revealResolvedSource('reveal', sel({ startRow: 40, startCol: 0, endRow: 40, endCol: 4 }));

    expect(scrollToLine).toHaveBeenCalledWith(10);
  });

  it('does nothing when the terminal instance is gone', () => {
    mocks.getTerminalInstance.mockReturnValue(null);
    revealResolvedSource('reveal', sel({ startRow: 1, startCol: 0, endRow: 1, endCol: 4 }));

    expect(scrollToLine).not.toHaveBeenCalled();
    expect(getMouseSelectionState('reveal').selection).toBeNull();
  });
});
