import { describe, it, expect } from 'vitest';
import { detectResumeCommand, resumeCommandLabel } from './resume-patterns';

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

describe('resumeCommandLabel', () => {
  it('drops the session argument', () => {
    expect(resumeCommandLabel('claude --resume 4f2c9b1e-6a03-4d5e')).toBe('claude --resume');
    expect(resumeCommandLabel('codex resume 01JCX8ZK5Q7M3N')).toBe('codex resume');
  });

  it('keeps an argument-free command whole', () => {
    expect(resumeCommandLabel('claude --continue')).toBe('claude --continue');
  });

  it('falls back to the command itself when no pattern claims it', () => {
    expect(resumeCommandLabel('nvim -S Session.vim')).toBe('nvim -S Session.vim');
  });
});
