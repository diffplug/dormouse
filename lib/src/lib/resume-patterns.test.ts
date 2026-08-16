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

  it('rejects shell syntax instead of persisting executable scrollback', () => {
    expect(detectResumeCommand('claude --resume $(touch${IFS}/tmp/pwn)\n')).toBeNull();
    expect(detectResumeCommand('codex resume safe; touch /tmp/pwn\n')).toBeNull();
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
