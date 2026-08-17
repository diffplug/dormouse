import { describe, it, expect } from 'vitest';
import { detectResumeCommand } from './resume-patterns';

describe('detectResumeCommand', () => {
  it('detects codex resume command', () => {
    const scrollback = 'some output\ncodex resume abc123\n$ ';
    expect(detectResumeCommand(scrollback)).toBe('codex resume abc123');
  });

  it('detects claude --resume command', () => {
    const scrollback = 'task output\nclaude --resume sess_xyz\n';
    expect(detectResumeCommand(scrollback)).toBe('claude --resume sess_xyz');
  });

  it('detects claude --continue command', () => {
    const scrollback = 'output\nTo continue this conversation, run: claude --continue\n';
    expect(detectResumeCommand(scrollback)).toBe('claude --continue');
  });

  it('strips terminal styling from a captured id', () => {
    const scrollback = 'claude --resume 4f2c9b1e-6a03-4d5e\x1b[0m\n';
    expect(detectResumeCommand(scrollback)).toBe('claude --resume 4f2c9b1e-6a03-4d5e');
  });

  it('never promotes an unterminated string control payload to visible text', () => {
    // A chunk or trim cut mid-OSC would otherwise leave the window title behind
    // as text, and a title is not something the pane can resume.
    expect(detectResumeCommand('\x1b]0;claude --resume evil\nprompt$ ')).toBeNull();
  });

  it('does not surrender a string-control payload that spans a newline', () => {
    // The scan window is stripped as a whole before it is split, so an OSC
    // whose payload carries an LF is removed as a unit. Stripping each raw
    // segment on its own handed the second half back as visible text.
    expect(detectResumeCommand('\x1b]0;title\nclaude --resume evil\x07\nuser$ ')).toBeNull();
    expect(detectResumeCommand('\x1bPtmux;a\nclaude --resume evil\x1b\\\nuser$ ')).toBeNull();
  });

  it('reads a hint that follows a terminated title on the same line', () => {
    // The unterminated-swallow rule must not eat text after a control that did
    // close: this is the ordinary case of a shell repainting its title.
    expect(detectResumeCommand('\x1b]0;~/proj\x07claude --resume abc123\n$ ')).toBe(
      'claude --resume abc123',
    );
  });

  it('reads a hint wrapped in prose punctuation', () => {
    // Rendering a command inside backticks, quotes or parens is how agents
    // normally print one mid-sentence; requiring whitespace after the id lost
    // every such hint.
    expect(detectResumeCommand('Resume with `claude --resume abc123`.\n')).toBe(
      'claude --resume abc123',
    );
    expect(detectResumeCommand("run 'codex resume 01JCX' now\n")).toBe('codex resume 01JCX');
    expect(detectResumeCommand('(claude --continue)\n')).toBe('claude --continue');
  });

  it('never captures shell syntax, only the invocation in front of it', () => {
    // The command is rebuilt as label + captured id, so what trails the id is
    // dropped rather than persisted — but an id that is *made of* shell syntax
    // never matches in the first place.
    expect(detectResumeCommand('claude --resume $(touch${IFS}/tmp/pwn)\n')).toBeNull();
    expect(detectResumeCommand('codex resume safe; touch /tmp/pwn\n')).toBe('codex resume safe');
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
    const scrollback = 'codex resume old123\n' + filler;
    expect(detectResumeCommand(scrollback)).toBeNull();
  });

  it('finds pattern in last 50 lines', () => {
    const filler = Array(40).fill('line').join('\n');
    const scrollback = filler + '\ncodex resume recent456\n';
    expect(detectResumeCommand(scrollback)).toBe('codex resume recent456');
  });

  it('returns the most recent match when the same command repeats', () => {
    const scrollback =
      'codex resume old123\nmore output\ncodex resume new789\n$ ';
    expect(detectResumeCommand(scrollback)).toBe('codex resume new789');
  });

  it('prefers the most recent command across pattern types', () => {
    const scrollback = 'codex resume abc\nlater\nclaude --resume xyz\n$ ';
    expect(detectResumeCommand(scrollback)).toBe('claude --resume xyz');
  });

  it('prefers the rightmost pattern after a carriage-return redraw', () => {
    const scrollback = 'codex resume old123\rclaude --resume new789';
    expect(detectResumeCommand(scrollback)).toBe('claude --resume new789');
  });

  it('prefers the rightmost repeated pattern in one raw segment', () => {
    const scrollback = 'codex resume old123\rcodex resume new789';
    expect(detectResumeCommand(scrollback)).toBe('codex resume new789');
  });
});

describe('screen-region seams', () => {
  // Observed in the wild: capture stored `claude --resume <uuid>codex`. A redraw
  // put a cursor move between the tail of an old echoed command and the start of
  // a new one; stripping it without a boundary welded them, and the greedy id
  // pattern ate across the seam.
  it('does not weld an id to text from another screen region', () => {
    const scrollback =
      'claude --resume 32ce9e59-ae07-4caf-8d71-6d90c3ea67ac\x1b[K\x1b[1;1Hcodex resume 01JCX8ZK\n';
    expect(detectResumeCommand(scrollback)).toBe('codex resume 01JCX8ZK');
  });

  it('treats a backspace redraw as a seam too', () => {
    const scrollback = 'claude --resume aaaa\x08\x08\x08\x08codex resume bbbb\n';
    expect(detectResumeCommand(scrollback)).toBe('codex resume bbbb');
  });

  it('treats the non-CSI cursor moves as seams too', () => {
    // `ESC M` (RI) scrolls up, `ESC 7`/`ESC 8` bracket a redraw, `ESC c` resets,
    // and VT/FF move down — a rule that seamed only CSI left every one of these
    // welding an id to the next screen region.
    for (const move of ['\x1bM', '\x1bD', '\x1bE', '\x1b7', '\x1b8', '\x1bc', '\x0b', '\x0c']) {
      expect(detectResumeCommand(`claude --resume old-aaa${move}codex resume new-bbb\n`))
        .toBe('codex resume new-bbb');
    }
  });

  it('does not read an id out of a CSI the buffer was cut off inside', () => {
    // A tail slice routinely lands mid-sequence; the parameters must not read as
    // text and extend the id sitting in front of them.
    expect(detectResumeCommand('codex resume abc\x1b[38;5')).toBe('codex resume abc');
  });

  it('still reads an id through a colour change, which does not move the cursor', () => {
    expect(detectResumeCommand('claude --resume \x1b[1m4f2c9b1e-6a03\x1b[0m\n'))
      .toBe('claude --resume 4f2c9b1e-6a03');
  });

  it('picks the newest hint when a redraw seam separates two agents', () => {
    // The real shape of the failure: a stale echoed claude command still on
    // screen, and the codex hint printed after a cursor move.
    const scrollback = 'x\nclaude --resume old-id-aaa\x1b[2Kcodex resume new-id-bbb\n$ ';
    expect(detectResumeCommand(scrollback)).toBe('codex resume new-id-bbb');
  });
});
