import { describe, expect, it } from 'vitest';
import { createPtyStrip } from './pty-strip';

const ESC = '\x1b';
const BEL = '\x07';

describe('createPtyStrip', () => {
  it('passes ordinary output through untouched', () => {
    const strip = createPtyStrip();
    expect(strip('hello\r\n$ ')).toBe('hello\r\n$ ');
  });

  it('removes the semantic OSCs the webview would have stripped', () => {
    const strip = createPtyStrip();
    // The phone renders the same bytes the laptop's xterm does, and the laptop
    // never sees these (docs/specs/terminal-escapes.md).
    expect(strip(`${ESC}]7;file:///tmp${BEL}ready`)).toBe('ready');
    expect(strip(`${ESC}]133;A${BEL}$ `)).toBe('$ ');
    expect(strip(`${ESC}]0;my title${BEL}x`)).toBe('x');
  });

  it('never surfaces a protocol response as output', () => {
    const strip = createPtyStrip();
    // The iTerm2 identity query is answered by the webview that owns the
    // terminal; a second answer from here would corrupt the PTY's input, so the
    // query is stripped and its answer discarded.
    expect(strip(`${ESC}[>qdone`)).toBe('done');
  });

  it('holds an OSC split across two chunks until it completes', () => {
    const strip = createPtyStrip();
    expect(strip(`a${ESC}]133;`)).toBe('a');
    expect(strip(`A${BEL}b`)).toBe('b');
  });

  it('keeps per-stream state to itself', () => {
    const first = createPtyStrip();
    const second = createPtyStrip();
    first(`${ESC}]133;`);
    // The second stream's bytes must not be swallowed by the first's pending OSC.
    expect(second('plain')).toBe('plain');
  });

  it('swallows a color query rather than passing it to the phone', () => {
    const strip = createPtyStrip();
    // The local adapter answers OSC 10/11/12 from the real theme. Left in the
    // stream this query reaches the phone's xterm, which answers it too, and
    // the second reply is written into the PTY's input — so it is consumed here
    // and the answer generated for it is thrown away.
    const out = strip(`before${ESC}]11;?${BEL}after`);
    expect(out).toBe('beforeafter');
    expect(out).not.toContain('?');
    expect(out).not.toContain('rgb:');
    expect(strip(`${ESC}]10;?${BEL}x${ESC}]12;?${BEL}y`)).toBe('xy');
  });
});
