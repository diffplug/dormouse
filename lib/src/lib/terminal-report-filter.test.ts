import { describe, expect, it } from 'vitest';
import {
  inputIsReplayTerminalReport,
  inputIsSyntheticTerminalReport,
  stripMouseReportsFromInput,
} from './terminal-report-filter';

describe('terminal-report-filter: mouse reports', () => {
  it('removes X10 / VT200 mouse reports', () => {
    expect(stripMouseReportsFromInput('\x1b[M !!')).toBe('');
  });

  it('removes SGR mouse press, release, and wheel reports', () => {
    const input = '\x1b[<0;12;4M\x1b[<0;12;4m\x1b[<64;12;4M';
    expect(stripMouseReportsFromInput(input)).toBe('');
  });

  it('removes URXVT mouse reports', () => {
    expect(stripMouseReportsFromInput('\x1b[32;12;4M')).toBe('');
  });

  it('preserves non-mouse input around stripped reports', () => {
    const input = 'a\x1b[<0;12;4M\r\x1b[M !!b';
    expect(stripMouseReportsFromInput(input)).toBe('a\rb');
  });
});

describe('terminal-report-filter: inputIsSyntheticTerminalReport', () => {
  it('accepts a string made entirely of terminal report escapes', () => {
    expect(inputIsSyntheticTerminalReport('\x1b[0n')).toBe(true); // DSR OK
    expect(inputIsSyntheticTerminalReport('\x1b[3;4R')).toBe(true); // cursor position report
    expect(inputIsSyntheticTerminalReport('\x1bOP')).toBe(true); // SS3 (F1)
    expect(inputIsSyntheticTerminalReport('\x1b]0;title\x07')).toBe(true); // OSC (BEL-terminated)
  });

  it('accepts several concatenated reports', () => {
    expect(inputIsSyntheticTerminalReport('\x1b[3;4R\x1b[0n')).toBe(true);
  });

  it('rejects empty input', () => {
    expect(inputIsSyntheticTerminalReport('')).toBe(false);
  });

  it('rejects any plain-text bytes (every chunk must validate)', () => {
    expect(inputIsSyntheticTerminalReport('abc')).toBe(false);
    expect(inputIsSyntheticTerminalReport('\r')).toBe(false);
    expect(inputIsSyntheticTerminalReport('\x1b[0nx')).toBe(false); // report + stray char
    expect(inputIsSyntheticTerminalReport('x\x1b[0n')).toBe(false); // stray char + report
  });
});

describe('terminal-report-filter: inputIsReplayTerminalReport', () => {
  it('accepts genuine replay-time report responses', () => {
    expect(inputIsReplayTerminalReport('\x1b[3;4R')).toBe(true); // cursor position report
    expect(inputIsReplayTerminalReport('\x1b[0n')).toBe(true); // device status report
    expect(inputIsReplayTerminalReport('\x1b[?1;2c')).toBe(true); // primary device attributes
    expect(inputIsReplayTerminalReport('\x1b[I')).toBe(true); // focus in
    expect(inputIsReplayTerminalReport('\x1b[O')).toBe(true); // focus out
  });

  it('rejects empty input', () => {
    expect(inputIsReplayTerminalReport('')).toBe(false);
  });

  it('rejects non-report escapes and plain text', () => {
    expect(inputIsReplayTerminalReport('\x1b[2J')).toBe(false); // clear screen — not a report
    expect(inputIsReplayTerminalReport('hello')).toBe(false);
    expect(inputIsReplayTerminalReport('\x1b[3;4Rx')).toBe(false); // report + stray char
  });
});
