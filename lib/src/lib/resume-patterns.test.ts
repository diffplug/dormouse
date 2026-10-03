import { describe, it, expect } from 'vitest';
import { detectResumeCommand } from './resume-patterns';

// Every registered agent prints a UUID. A seam or style change can fall inside
// one, so some cases split it.
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const A_HEAD = A.slice(0, 18);
const A_TAIL = A.slice(18);

describe('detectResumeCommand', () => {
  it.each(['\x1b[', '\x9b'])('preserves recovery ID boundaries for CSI %j', (csi) => {
    expect(detectResumeCommand(`codex resume ${A_HEAD}${csi}31m${A_TAIL}\n`)).toBe(`codex resume ${A}`);
    expect(detectResumeCommand(`codex resume ${A}${csi}2Kxyz\n`)).toBe(`codex resume ${A}`);
    expect(detectResumeCommand(`codex resume ${A}${csi}38;5`)).toBeNull();
  });
  it.each(['\x1bD', '\x84', '\x1bE', '\x85', '\x1bM', '\x8d'])('does not weld recovery IDs across movement %j', (move) => {
    expect(detectResumeCommand(`codex resume ${A}${move}xyz\n`)).toBe(`codex resume ${A}`);
    expect(detectResumeCommand(`codex resume ${A_HEAD}${move}${A_TAIL}\n`)).toBeNull();
  });

  it.each(['\n', '\r', '\t', ' ', '`', "'", ')', '.', '\x1b[K'])(
    'accepts an observed separator %j after the ID', (separator) => {
      expect(detectResumeCommand(`codex resume ${A}${separator}`)).toBe(`codex resume ${A}`);
    },
  );

  it('waits for a separator after the newest hint without falling back to an older one', () => {
    const output = `codex resume ${A}\nclaude --resume ${B}`;
    expect(detectResumeCommand(output)).toBeNull();
    expect(detectResumeCommand(`${output}\n`)).toBe(`claude --resume ${B}`);
    expect(detectResumeCommand('claude --continue')).toBeNull();
    expect(detectResumeCommand('claude --continue\n')).toBe('claude --continue');
  });

  it.each(['\x1b[0m', '\x1b', '\x1b[38;5', '\x1b(', '\x1b]0;title'])(
    'does not treat trailing styling or an unfinished control %j as a separator', (tail) => {
      expect(detectResumeCommand(`codex resume ${A}${tail}`)).toBeNull();
    },
  );

  it('keeps an ID intact across a split charset designator', () => {
    expect(detectResumeCommand(`codex resume ${A_HEAD}\x1b(`)).toBeNull();
    expect(detectResumeCommand(`codex resume ${A_HEAD}\x1b(B${A_TAIL}\n`)).toBe(`codex resume ${A}`);
  });

  it('detects codex resume command', () => {
    const scrollback = `some output\ncodex resume ${A}\n$ `;
    expect(detectResumeCommand(scrollback)).toBe(`codex resume ${A}`);
  });

  it('detects claude --resume command', () => {
    const scrollback = `task output\nclaude --resume ${A}\n`;
    expect(detectResumeCommand(scrollback)).toBe(`claude --resume ${A}`);
  });

  it('detects claude --continue command', () => {
    const scrollback = 'output\nTo continue this conversation, run: claude --continue\n';
    expect(detectResumeCommand(scrollback)).toBe('claude --continue');
  });

  it('strips terminal styling from a captured id', () => {
    const scrollback = `claude --resume ${A}\x1b[0m\n`;
    expect(detectResumeCommand(scrollback)).toBe(`claude --resume ${A}`);
  });

  it('never promotes an unterminated string control payload to visible text', () => {
    // A chunk or trim cut mid-OSC would otherwise leave the window title behind
    // as text, and a title is not something the pane can resume.
    expect(detectResumeCommand(`\x1b]0;claude --resume ${A}\nprompt$ `)).toBeNull();
  });

  it('does not surrender a string-control payload that spans a newline', () => {
    // The scan window is stripped as a whole before it is split, so an OSC
    // whose payload carries an LF is removed as a unit. Stripping each raw
    // segment on its own handed the second half back as visible text.
    expect(detectResumeCommand(`\x1b]0;title\nclaude --resume ${A}\x07\nuser$ `)).toBeNull();
    expect(detectResumeCommand(`\x1bPtmux;a\nclaude --resume ${A}\x1b\\\nuser$ `)).toBeNull();
  });

  it('reads a hint that follows a terminated title on the same line', () => {
    // The unterminated-swallow rule must not eat text after a control that did
    // close: this is the ordinary case of a shell repainting its title.
    expect(detectResumeCommand(`\x1b]0;~/proj\x07claude --resume ${A}\n$ `)).toBe(`claude --resume ${A}`);
  });

  it('reads a hint wrapped in prose punctuation', () => {
    // Rendering a command inside backticks, quotes or parens is how agents
    // normally print one mid-sentence; requiring whitespace after the id lost
    // every such hint.
    expect(detectResumeCommand(`Resume with \`claude --resume ${A}\`.\n`)).toBe(`claude --resume ${A}`);
    expect(detectResumeCommand(`run 'codex resume ${B}' now\n`)).toBe(`codex resume ${B}`);
    expect(detectResumeCommand('(claude --continue)\n')).toBe('claude --continue');
  });

  it('never captures shell syntax, only the invocation in front of it', () => {
    // The command is rebuilt as label + captured id, so what trails the id is
    // dropped rather than persisted — but an id that is *made of* shell syntax
    // never matches in the first place.
    expect(detectResumeCommand('claude --resume $(touch${IFS}/tmp/pwn)\n')).toBeNull();
    expect(detectResumeCommand(`codex resume ${A}; touch /tmp/pwn\n`)).toBe(`codex resume ${A}`);
  });

  it('skips a terminated token that is not the agent\'s id shape', () => {
    // Codex 0.160 follows its hint with `Or run codex resume and select <thread>.`
    expect(detectResumeCommand(`codex resume ${A}\nOr run codex resume and select Fix it.\n`))
      .toBe(`codex resume ${A}`);
    // Copilot hard-wraps a narrow pane's hint mid-id; the fragment is no id.
    expect(detectResumeCommand(`Resume copilot --resume=${A_HEAD}\n${A_TAIL}\n`)).toBeNull();
    // A pending id still holds the scan: no falling back past it to an older hint.
    expect(detectResumeCommand(`codex resume ${A}\nclaude --resume ${B.slice(0, 9)}`)).toBeNull();
  });

  it('does not match an invocation that is the prefix of a longer word', () => {
    expect(detectResumeCommand('claude --continuex\n')).toBeNull();
    expect(detectResumeCommand('claude --continue-session\n')).toBeNull();
  });

  it('returns null when no pattern matches', () => {
    const scrollback = 'regular output\n$ ls\nfile1 file2\n$ ';
    expect(detectResumeCommand(scrollback)).toBeNull();
  });

  it('returns null for empty scrollback', () => {
    expect(detectResumeCommand('')).toBeNull();
  });

  it('only scans last 50 lines', () => {
    const filler = Array(100).fill('line').join('\n');
    const scrollback = `codex resume ${A}\n${filler}`;
    expect(detectResumeCommand(scrollback)).toBeNull();
  });

  it('finds pattern in last 50 lines', () => {
    const filler = Array(40).fill('line').join('\n');
    const scrollback = `${filler}\ncodex resume ${A}\n`;
    expect(detectResumeCommand(scrollback)).toBe(`codex resume ${A}`);
  });

  it('returns the most recent match when the same command repeats', () => {
    const scrollback = `codex resume ${A}\nmore output\ncodex resume ${B}\n$ `;
    expect(detectResumeCommand(scrollback)).toBe(`codex resume ${B}`);
  });

  it('prefers the most recent command across pattern types', () => {
    const scrollback = `codex resume ${A}\nlater\nclaude --resume ${B}\n$ `;
    expect(detectResumeCommand(scrollback)).toBe(`claude --resume ${B}`);
  });

  it('prefers the rightmost pattern after a carriage-return redraw', () => {
    const scrollback = `codex resume ${A}\rclaude --resume ${B}\n`;
    expect(detectResumeCommand(scrollback)).toBe(`claude --resume ${B}`);
  });

  it('prefers the rightmost repeated pattern in one raw segment', () => {
    const scrollback = `codex resume ${A}\rcodex resume ${B}\n`;
    expect(detectResumeCommand(scrollback)).toBe(`codex resume ${B}`);
  });
});

describe('screen-region seams', () => {
  // Observed in the wild: capture stored `claude --resume <uuid>codex`. A redraw
  // put a cursor move between the tail of an old echoed command and the start of
  // a new one; stripping it without a boundary welded them, and the greedy id
  // pattern ate across the seam.
  it('does not weld an id to text from another screen region', () => {
    const scrollback =
      `claude --resume ${A}\x1b[K\x1b[1;1Hcodex resume ${B}\n`;
    expect(detectResumeCommand(scrollback)).toBe(`codex resume ${B}`);
  });

  it('treats a backspace redraw as a seam too', () => {
    const scrollback = `claude --resume ${A}\x08\x08\x08\x08codex resume ${B}\n`;
    expect(detectResumeCommand(scrollback)).toBe(`codex resume ${B}`);
  });

  it('treats the non-CSI cursor moves as seams too', () => {
    // `ESC M` (RI) scrolls up, `ESC 7`/`ESC 8` bracket a redraw, `ESC c` resets,
    // and VT/FF move down — a rule that seamed only CSI left every one of these
    // welding an id to the next screen region.
    for (const move of ['\x1bM', '\x1bD', '\x1bE', '\x1b7', '\x1b8', '\x1bc', '\x0b', '\x0c']) {
      expect(detectResumeCommand(`claude --resume ${A}${move}codex resume ${B}\n`))
        .toBe(`codex resume ${B}`);
    }
  });

  it('does not read an id out of a CSI the buffer was cut off inside', () => {
    // A tail slice routinely lands mid-sequence; the parameters must not read as
    // text and extend the id sitting in front of them.
    expect(detectResumeCommand(`codex resume ${A_HEAD}\x1b[38;5`)).toBeNull();
    expect(detectResumeCommand(`codex resume ${A_HEAD}\x1b[38;5;2m${A_TAIL}\n`)).toBe(`codex resume ${A}`);
  });

  it('still reads an id through a colour change, which does not move the cursor', () => {
    expect(detectResumeCommand(`claude --resume \x1b[1m${A}\x1b[0m\n`)).toBe(`claude --resume ${A}`);
  });

  it('picks the newest hint when a redraw seam separates two agents', () => {
    // The real shape of the failure: a stale echoed claude command still on
    // screen, and the codex hint printed after a cursor move.
    const scrollback = `x\nclaude --resume ${A}\x1b[2Kcodex resume ${B}\n$ `;
    expect(detectResumeCommand(scrollback)).toBe(`codex resume ${B}`);
  });
});
