/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { REPLAY_MODE_RESET } from './terminal-report-filter';
import { attachMouseModeObserver } from './mouse-mode-observer';
import { __resetMouseSelectionForTests, getMouseSelectionState } from './mouse-selection';

afterEach(() => {
  __resetMouseSelectionForTests();
  vi.restoreAllMocks();
});

// A real (headless) xterm instance parses the reset tail and updates
// `terminal.modes`, so these tests assert the actual xterm-modeled effect rather
// than a mock. No `.open()` is needed — the parser runs on `write()` regardless.
function makeTerminal(): Terminal {
  return new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
}

async function write(terminal: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve));
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('REPLAY_MODE_RESET', () => {
  it('sets no private mode (DECSET) except show-cursor (?25h)', () => {
    // Sanity: a reset tail that turned a mode ON would be a bug. The only `h`
    // sequence permitted is ?25h (show cursor); everything else is a DECRST or
    // the SGR reset.
    const setSequences = REPLAY_MODE_RESET.match(/\x1b\[[?\d;]*h/g) ?? [];
    expect(setSequences).toEqual(['\x1b[?25h']);
  });

  it('returns a terminal left mid-TUI to a sane baseline', async () => {
    const terminal = makeTerminal();
    // Persisted scrollback of a dead TUI that latched mouse tracking, SGR mouse
    // encoding, alt-screen, hidden cursor, application cursor keys, bracketed
    // paste — exactly what replaying verbatim re-applies with no process alive.
    await write(
      terminal,
      'saved output\x1b[?1000h\x1b[?1006h\x1b[?1049h\x1b[?25l\x1b[?1h\x1b[?2004h',
    );
    expect(terminal.modes.mouseTrackingMode).toBe('vt200');
    expect(terminal.buffer.active.type).toBe('alternate');
    expect(terminal.modes.showCursor).toBe(false);
    expect(terminal.modes.applicationCursorKeysMode).toBe(true);
    expect(terminal.modes.bracketedPasteMode).toBe(true);

    await write(terminal, REPLAY_MODE_RESET);

    expect(terminal.modes.mouseTrackingMode).toBe('none');
    expect(terminal.buffer.active.type).toBe('normal');
    expect(terminal.modes.showCursor).toBe(true);
    expect(terminal.modes.applicationCursorKeysMode).toBe(false);
    expect(terminal.modes.bracketedPasteMode).toBe(false);
    terminal.dispose();
  });

  it('clears any-motion (?1003h) tracking too', async () => {
    const terminal = makeTerminal();
    await write(terminal, '\x1b[?1003h\x1b[?1006h');
    expect(terminal.modes.mouseTrackingMode).toBe('any');
    await write(terminal, REPLAY_MODE_RESET);
    expect(terminal.modes.mouseTrackingMode).toBe('none');
    terminal.dispose();
  });

  it('re-syncs the mouse-selection store to none via the mode observer', async () => {
    // The observer's DECSET/DECRST parser hooks fire on the reset writes, so the
    // stale mouse mode that would otherwise break terminal text selection is
    // cleared with no extra plumbing.
    const id = 'reset-observer';
    const terminal = makeTerminal();
    const observer = attachMouseModeObserver(id, terminal);

    await write(terminal, '\x1b[?1000h\x1b[?1006h');
    await flushMicrotasks();
    expect(getMouseSelectionState(id).mouseReporting).toBe('vt200');

    await write(terminal, REPLAY_MODE_RESET);
    await flushMicrotasks();
    expect(getMouseSelectionState(id).mouseReporting).toBe('none');

    observer.dispose();
    terminal.dispose();
  });
});
