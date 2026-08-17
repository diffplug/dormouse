import { describe, expect, it } from 'vitest';
import { stripTerminalControls } from './terminal-controls';

describe('stripTerminalControls', () => {
  it('removes terminated string controls with their payload', () => {
    expect(stripTerminalControls('\x1b]0;window title\x07user$ ')).toBe('user$ ');
    expect(stripTerminalControls('\x1bP+q544e\x1b\\user$ ')).toBe('user$ ');
    // APC/PM/SOS are ST-terminated too — kitty's graphics protocol is an APC,
    // so a pane running an image-capable tool emits one routinely. Without
    // these the ESC catch-all would strip the introducer and promote the
    // payload to text both detectors read.
    expect(stripTerminalControls('\x1b_Gf=100;claude --resume evil\x1b\\user$ ')).toBe('user$ ');
    expect(stripTerminalControls('\x1b^private;claude --resume evil\x1b\\user$ ')).toBe('user$ ');
    expect(stripTerminalControls('\x1bXstring;claude --resume evil\x1b\\user$ ')).toBe('user$ ');
    // ST's 8-bit form terminates just as well; without it the swallow below
    // would eat the prompt trailing a title OSC.
    expect(stripTerminalControls('prev line\n\x1b]0;t\x9cuser@host repo % ')).toBe(
      'prev line\nuser@host repo % ',
    );
    // xterm aborts a string control on CAN/SUB and ends it on a bare ESC, so
    // the text behind one is rendered output — the swallow below must not eat
    // the prompt trailing any of the three.
    expect(stripTerminalControls('prev line\n\x1b]0;t\x18user@host repo % ')).toBe(
      'prev line\nuser@host repo % ',
    );
    expect(stripTerminalControls('prev line\n\x1b]0;t\x1auser@host repo % ')).toBe(
      'prev line\nuser@host repo % ',
    );
    expect(stripTerminalControls('prev line\n\x1b]0;t\x1b[0muser@host repo % ')).toBe(
      'prev line\nuser@host repo % ',
    );
    expect(stripTerminalControls('prev line\n\x1b_Gf=100;xx\x18user@host repo % ')).toBe(
      'prev line\nuser@host repo % ',
    );
  });

  it('swallows the rest of the input after an unterminated string control', () => {
    // A chunk boundary or a scrollback trim can cut mid-sequence; the payload
    // must not be promoted to text by the ESC catch-all below it.
    expect(stripTerminalControls('done\n\x1b]0;claude --resume evil\nuser$ ')).toBe('done\n');
    expect(stripTerminalControls('done\n\x1bPtmux;still payload')).toBe('done\n');
    expect(stripTerminalControls('done\n\x1b_Gf=100;claude --resume evil')).toBe('done\n');
  });

  it('removes CSI sequences including the private parameter bytes', () => {
    expect(stripTerminalControls('\x1b[1;31mred\x1b[0m')).toBe('red');
    expect(stripTerminalControls('\x1b[?1049halt\x1b[?1049l')).toBe('alt');
    // `<`, `=`, `>`, `:` are legal parameter bytes (SGR mouse, colon subparams).
    expect(stripTerminalControls('\x1b[<35;10;4Mmouse')).toBe('mouse');
    expect(stripTerminalControls('\x1b[38:2:255:0:0mcolor')).toBe('color');
  });

  it('swallows a CSI the input was cut off in the middle of', () => {
    // Without this the ESC catch-all matches `\x1b[` alone and the parameters
    // read as text — welded straight onto a greedy id capture.
    expect(stripTerminalControls('claude --resume aaa\x1b[38;5')).toBe('claude --resume aaa');
    expect(stripTerminalControls('claude --resume aaa\x1b[', { boundaries: true })).toBe(
      'claude --resume aaa\n',
    );
  });

  it('removes charset designators and every other escape sequence whole', () => {
    expect(stripTerminalControls('\x1b(Bplain')).toBe('plain');
    expect(stripTerminalControls('\x1b*Bplain')).toBe('plain');
    expect(stripTerminalControls('a\x1bMb')).toBe('ab');
    // Fp (0x30-0x3f) and Fs (0x60-0x7e) finals live outside the Fe range, and a
    // rule that matched only Fe left the final byte behind as visible text —
    // `\x1b8` reading as `8` silently corrupts the id it lands next to.
    expect(stripTerminalControls('claude --resume abc\x1b8')).toBe('claude --resume abc');
    expect(stripTerminalControls('claude --resume abc\x1b7def')).toBe('claude --resume abcdef');
    expect(stripTerminalControls('claude --resume abc\x1bcxyz')).toBe('claude --resume abcxyz');
    expect(stripTerminalControls('a\x1b=b\x1b>c')).toBe('abc');
    expect(stripTerminalControls('a\x1b#8b')).toBe('ab');
  });

  it('keeps LF, CR and TAB as text boundaries and drops other control bytes', () => {
    expect(stripTerminalControls('a\r\nb\tc')).toBe('a\r\nb\tc');
    expect(stripTerminalControls('a\x00\x07\x7f\x9fb')).toBe('ab');
  });

  describe('boundaries', () => {
    it('seams non-SGR CSI and backspace but not SGR or charset designators', () => {
      expect(stripTerminalControls('building...\x1b[1;1H➜  ~ ', { boundaries: true })).toBe(
        'building...\n➜  ~ ',
      );
      expect(stripTerminalControls('red\x1b[31mgreen', { boundaries: true })).toBe('redgreen');
      expect(stripTerminalControls('a\x1b(Bb', { boundaries: true })).toBe('ab');
      expect(stripTerminalControls('a\x08b', { boundaries: true })).toBe('a\nb');
    });

    it('seams the non-CSI cursor moves too', () => {
      // `ESC M` (RI) is how a TUI scrolls up, and VT/FF move the cursor down —
      // each welds two screen regions exactly the way a CSI move does. Deleting
      // them produced the `<id>codex` capture this option exists to prevent.
      for (const move of ['\x1bM', '\x1bD', '\x1bE', '\x1b7', '\x1b8', '\x1bc', '\x0b', '\x0c']) {
        expect(
          stripTerminalControls(`claude --resume aaa${move}codex resume bbb`, { boundaries: true }),
        ).toBe('claude --resume aaa\ncodex resume bbb');
      }
    });
  });
});
