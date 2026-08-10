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
