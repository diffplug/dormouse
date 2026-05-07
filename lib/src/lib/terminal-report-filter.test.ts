import { describe, expect, it } from 'vitest';
import { stripMouseReportsFromInput } from './terminal-report-filter';

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
