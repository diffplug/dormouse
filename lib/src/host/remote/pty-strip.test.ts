import { describe, expect, it } from 'vitest';
import { createPtyStrip } from './pty-strip';

const ESC = '\x1b';
const BEL = '\x07';

describe('createPtyStrip', () => {
  it('passes ordinary output through untouched, with no separate text projection', () => {
    const strip = createPtyStrip();
    // Omitting `textData` is the contract for "identical to `data`", so a chunk
    // with no string control costs one string on the wire, not two.
    expect(strip('hello\r\n$ ')).toEqual({ data: 'hello\r\n$ ' });
  });

  it('removes the semantic OSCs the webview would have stripped', () => {
    const strip = createPtyStrip();
    // The phone renders the same bytes the laptop's xterm does, and the laptop
    // never sees these (docs/specs/terminal-escapes.md).
    expect(strip(`${ESC}]7;file:///tmp${BEL}ready`)).toEqual({ data: 'ready' });
    expect(strip(`${ESC}]133;A${BEL}$ `)).toEqual({ data: '$ ' });
    expect(strip(`${ESC}]0;my title${BEL}x`)).toEqual({ data: 'x' });
  });

  it('carries the text projection whenever it differs from the renderer one', () => {
    const strip = createPtyStrip();
    // A forwarded image sequence stays in `data` for ImageAddon and is absent
    // from `textData`, so its base64 never reaches a prompt heuristic.
    expect(strip(`pre${ESC}]1337;File=inline=1:AAAA${BEL}post`)).toEqual({
      data: `pre${ESC}]1337;File=inline=1:AAAA${BEL}post`,
      textData: 'prepost',
    });
  });

  it('never surfaces a protocol response as output', () => {
    const strip = createPtyStrip();
    // The iTerm2 identity query is answered by the webview that owns the
    // terminal; a second answer from here would corrupt the PTY's input, so the
    // query is stripped and its answer discarded.
    expect(strip(`${ESC}[>qdone`)).toEqual({ data: 'done' });
  });

  it('holds an OSC split across two chunks until it completes', () => {
    const strip = createPtyStrip();
    expect(strip(`a${ESC}]133;`)).toEqual({ data: 'a' });
    expect(strip(`A${BEL}b`)).toEqual({ data: 'b' });
  });

  it('keeps per-stream state to itself', () => {
    const first = createPtyStrip();
    const second = createPtyStrip();
    first(`${ESC}]133;`);
    // The second stream's bytes must not be swallowed by the first's pending OSC.
    expect(second('plain')).toEqual({ data: 'plain' });
  });

  it('swallows a color query rather than passing it to the phone', () => {
    const strip = createPtyStrip();
    // The local adapter answers OSC 10/11/12 from the real theme. Left in the
    // stream this query reaches the phone's xterm, which answers it too, and
    // the second reply is written into the PTY's input — so it is consumed here
    // and the answer generated for it is thrown away.
    const out = strip(`before${ESC}]11;?${BEL}after`);
    expect(out).toEqual({ data: 'beforeafter' });
    expect(out.data).not.toContain('?');
    expect(out.data).not.toContain('rgb:');
    expect(strip(`${ESC}]10;?${BEL}x${ESC}]12;?${BEL}y`)).toEqual({ data: 'xy' });
  });
});
