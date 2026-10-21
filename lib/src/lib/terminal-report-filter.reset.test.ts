/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { REPLAY_MODE_RESET } from './terminal-report-filter';
import { attachKeyboardProtocolArbiter } from './keyboard-protocol-arbiter';
import { attachMouseModeObserver } from './mouse-mode-observer';
import { __resetMouseSelectionForTests, getMouseSelectionState } from './mouse-selection';

afterEach(() => {
  __resetMouseSelectionForTests();
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
  it('clears text-layout modes without erasing the retained transcript', async () => {
    const terminal = makeTerminal();
    await write(terminal, 'retained output\r\n\x1b[4h\x1b[?66h\x1b[?45h\x1b[?7l\x1b[3;10r\x1b[?6h');
    expect(terminal.modes.insertMode).toBe(true);
    expect(terminal.modes.applicationKeypadMode).toBe(true);
    expect(terminal.modes.originMode).toBe(true);
    expect(terminal.modes.wraparoundMode).toBe(false);

    await write(terminal, REPLAY_MODE_RESET);

    expect(terminal.modes.insertMode).toBe(false);
    expect(terminal.modes.applicationKeypadMode).toBe(false);
    expect(terminal.modes.originMode).toBe(false);
    expect(terminal.modes.reverseWraparoundMode).toBe(false);
    expect(terminal.modes.wraparoundMode).toBe(true);
    expect(terminal.buffer.normal.getLine(0)?.translateToString(true)).toBe('retained output');
    await write(terminal, '\x1b[24;1Hlast row\r\nnew line');
    expect(terminal.buffer.normal.getLine(terminal.buffer.normal.baseY + 22)?.translateToString(true)).toBe('last row');
    expect(terminal.buffer.normal.getLine(terminal.buffer.normal.baseY + 23)?.translateToString(true)).toBe('new line');
    terminal.dispose();
  });

  it('clears both kitty stacks and restores Windows keyboard negotiation for a new process', async () => {
    const terminal = new Terminal({ allowProposedApi: true, vtExtensions: { kittyKeyboard: true, win32InputMode: true } });
    const arbiter = attachKeyboardProtocolArbiter(terminal);
    const replies: string[] = [];
    const listener = terminal.onData(data => replies.push(data));
    await write(terminal, '\x1b[>1u\x1b[>3u\x1b[?1049h\x1b[>7u');
    expect(terminal.options.vtExtensions?.win32InputMode).toBe(false);

    await write(terminal, REPLAY_MODE_RESET);
    await write(terminal, '\x1b[?u\x1b[<u\x1b[?u\x1b[?1049h\x1b[?u\x1b[<u\x1b[?u');
    expect(replies).toEqual(Array(4).fill('\x1b[?0u'));
    expect(terminal.options.vtExtensions?.win32InputMode).toBe(true);

    await write(terminal, '\x1b[>1u');
    expect(terminal.options.vtExtensions?.win32InputMode).toBe(false);
    await write(terminal, '\x1b[<u');
    expect(terminal.options.vtExtensions?.win32InputMode).toBe(true);
    listener.dispose();
    arbiter.dispose();
    terminal.dispose();
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
