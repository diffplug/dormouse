import { describe, expect, it } from 'vitest';
import { outputPaints } from './output-paints';

describe('outputPaints', () => {
  it.each([
    ['an idle Claude Code cursor-position poll', '\x1b[?6n'],
    ['image-size queries with a palette reset', '\x1b[16t\x1b[c\x1b]104;255\x07'],
    ['a Codex frame that resets colors and moves the cursor', '\x1b[?2026h\x1b[39m\x1b[49m\x1b[0m\x1b[51;3H\x1b[?25h\x1b[?2026l'],
    ['mode and key-protocol toggles', '\x1b[?1004h\x1b[?2004l\x1b[>1u\x1b[<u\x1b[>4;1m\x1b[2 q'],
    ['save, restore, charsets and keypad', '\x1b7\x1b8\x1b(B\x1b=\x1b>'],
    ['bare controls', '\r\x07\b\t'],
    ['a notification, a cwd and a color set', '\x1b]9;done\x07\x1b]7;file:///tmp\x1b\\\x1b]11;#000000\x1b\\'],
    ['a DECRQSS query', '\x1bP$qm\x1b\\'],
    ['C1 forms', '\x9b?6n\x9d9;done\x9c'],
    ['nothing', ''],
  ])('discounts %s', (_, data) => expect(outputPaints(data)).toBe(false));

  it.each([
    ['text', 'x'],
    ['a space', ' '],
    ['a line feed', '\n'],
    ['text inside a synchronized frame', '\x1b[?2026h\x1b[1;1Hhi\x1b[?2026l'],
    ['an erase', '\x1b[2K'],
    ['a scroll', '\x1b[3S'],
    ['an alt-screen switch', '\x1b[?1049h'],
    ['a title', '\x1b]0;✳ Claude Code\x07'],
    ['a reverse index', '\x1bM'],
    ['a SIXEL image', '\x1bPq#0;2;0;0;0#0~~\x1b\\'],
    ['an unknown CSI', '\x1b[5z'],
    ['a sequence cut off by the chunk', '\x1b[?6'],
  ])('counts %s', (_, data) => expect(outputPaints(data)).toBe(true));
});
