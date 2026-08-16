import { describe, expect, it } from 'vitest';
import { stripTerminalControls } from './terminal-controls';

describe('stripTerminalControls', () => {
  it('removes terminated string controls with their payload', () => {
    expect(stripTerminalControls('\x1b]0;window title\x07user$ ')).toBe('user$ ');
    expect(stripTerminalControls('\x1bP+q544e\x1b\\user$ ')).toBe('user$ ');
  });

  it('swallows the rest of the input after an unterminated string control', () => {
    // A chunk boundary or a scrollback trim can cut mid-sequence; the payload
    // must not be promoted to text by the ESC catch-all below it.
    expect(stripTerminalControls('done\n\x1b]0;claude --resume evil\nuser$ ')).toBe('done\n');
    expect(stripTerminalControls('done\n\x1bPtmux;still payload')).toBe('done\n');
  });

  it('removes CSI sequences including the private parameter bytes', () => {
    expect(stripTerminalControls('\x1b[1;31mred\x1b[0m')).toBe('red');
    expect(stripTerminalControls('\x1b[?1049halt\x1b[?1049l')).toBe('alt');
    // `<`, `=`, `>`, `:` are legal parameter bytes (SGR mouse, colon subparams).
    expect(stripTerminalControls('\x1b[<35;10;4Mmouse')).toBe('mouse');
    expect(stripTerminalControls('\x1b[38:2:255:0:0mcolor')).toBe('color');
  });

  it('removes charset designators and stray two-byte escapes', () => {
    expect(stripTerminalControls('\x1b(Bplain')).toBe('plain');
    expect(stripTerminalControls('a\x1bMb')).toBe('ab');
  });

  it('keeps LF, CR and TAB as text boundaries and drops other control bytes', () => {
    expect(stripTerminalControls('a\r\nb\tc')).toBe('a\r\nb\tc');
    expect(stripTerminalControls('a\x00\x07\x7f\x9fb')).toBe('ab');
  });
});
