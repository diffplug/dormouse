// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { FRESH_TERMINAL_MODES } from '../remote/test-terminal-modes';
import { readTerminalModes, terminalModesReplay } from './terminal-modes';
import { REPLAY_MODE_RESET } from './terminal-report-filter';
import { xtermVtExtensions } from './xterm-options';

const write = (terminal: Terminal, data: string) => new Promise<void>(resolve => terminal.write(data, resolve));

const live: Terminal[] = [];
afterEach(() => { for (const terminal of live.splice(0)) terminal.dispose(); });

const newTerminal = () => {
  const terminal = new Terminal({ allowProposedApi: true, vtExtensions: xtermVtExtensions() });
  live.push(terminal);
  return terminal;
};

describe('readTerminalModes', () => {
  it('reads a fresh terminal as every mode at its default', () => {
    expect(readTerminalModes(newTerminal())).toEqual(FRESH_TERMINAL_MODES);
  });

  it('reads what a running program set, kitty pushes per screen included', async () => {
    const terminal = newTerminal();
    await write(terminal, '\x1b[?1h\x1b[?66h\x1b[?2004h\x1b[4h\x1b[?6h\x1b[?45h\x1b[?7l\x1b[?25l\x1b[?1004h'
      + '\x1b[?1002h\x1b[?1006h\x1b[?2031h\x1b[5 q\x1b[>1u\x1b[>3u\x1b[?1049h\x1b[>5u');

    const modes = readTerminalModes(terminal);

    expect(modes).toMatchObject({
      applicationCursorKeys: true,
      applicationKeypad: true,
      bracketedPaste: true,
      insert: true,
      origin: true,
      reverseWraparound: true,
      wraparound: false,
      showCursor: false,
      sendFocus: true,
      mouseTracking: 'drag',
      mouseEncoding: 'sgr',
      colorSchemeUpdates: true,
      cursorStyle: 'bar',
      cursorBlink: true,
      alternateScreen: true,
    });
    expect(modes.kittyKeyboard.main).toEqual([1, 3]);
    expect(modes.kittyKeyboard.alternate).toEqual([5]);
  });

  it('reads the main screen\'s kitty pushes alone while it shows', async () => {
    const terminal = newTerminal();
    await write(terminal, '\x1b[>1u\x1b[?1049h\x1b[>5u\x1b[?1049l\x1b[?1016h');

    const modes = readTerminalModes(terminal);

    expect(modes.alternateScreen).toBe(false);
    expect(modes.mouseEncoding).toBe('sgrPixels');
    expect(modes.kittyKeyboard.main).toEqual([1]);
    expect(modes.kittyKeyboard.alternate).toEqual([]);
  });
});

describe('terminalModesReplay', () => {
  const SET_EVERYTHING = '\x1b[?1h\x1b[?66h\x1b[?2004h\x1b[4h\x1b[?6h\x1b[?45h\x1b[?7l\x1b[?25l\x1b[?1004h'
    + '\x1b[?1003h\x1b[?1016h\x1b[?2031h\x1b[4 q\x1b[>1u\x1b[>3u\x1b[?1049h\x1b[>5u\x1b[>7u';

  it('puts a fresh terminal into the modes another one read', async () => {
    const source = newTerminal();
    await write(source, SET_EVERYTHING);
    const target = newTerminal();

    await write(target, terminalModesReplay(readTerminalModes(source)));

    expect(readTerminalModes(target)).toEqual(readTerminalModes(source));
  });

  it('clears what a terminal attached before still holds', async () => {
    const target = newTerminal();
    await write(target, SET_EVERYTHING);

    await write(target, terminalModesReplay(FRESH_TERMINAL_MODES));

    expect(readTerminalModes(target)).toEqual(FRESH_TERMINAL_MODES);
  });

  it('reads anything malformed or missing as its default', () => {
    const malformed = {
      mouseTracking: 'constructor',
      mouseEncoding: '__proto__',
      cursorStyle: 'toString',
      bracketedPaste: 'yes',
      kittyKeyboard: { main: [1.5, 32, -1, '1;2'], alternate: 'x' },
    } as unknown as Parameters<typeof terminalModesReplay>[0];
    expect(terminalModesReplay(malformed)).toBe(REPLAY_MODE_RESET);
    expect(terminalModesReplay(undefined)).toBe(REPLAY_MODE_RESET);
  });
});
