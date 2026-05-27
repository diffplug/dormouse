import { describe, expect, it } from 'vitest';
import { derivePromptShape, extractCommand } from './terminal-prompt-shape';

describe('derivePromptShape', () => {
  it('reads the zsh terminator and ignores earlier non-alphanumerics', () => {
    expect(derivePromptShape('ntwigg@ntwigg-mac-2025 mouseterm % ')).toEqual({ terminator: '%', countBefore: 0 });
  });

  it('reads the cmd.exe terminator as ">" regardless of the path', () => {
    // The trailing "run" looks like ":\>" only at the drive root; the stable
    // terminator is just ">".
    expect(derivePromptShape('C:\\Users\\ntwigg>')).toEqual({ terminator: '>', countBefore: 0 });
    expect(derivePromptShape('C:\\>')).toEqual({ terminator: '>', countBefore: 0 });
  });

  it('counts an embedded terminator in a themed prompt', () => {
    expect(derivePromptShape('[50%] user dir % ')).toEqual({ terminator: '%', countBefore: 1 });
  });

  it('handles a bash $ and an arrow prompt', () => {
    expect(derivePromptShape('user@host:~/dir$ ')).toEqual({ terminator: '$', countBefore: 0 });
    expect(derivePromptShape('❯ ')).toEqual({ terminator: '❯', countBefore: 0 });
  });

  it('returns null when the prompt has no recognized terminator', () => {
    expect(derivePromptShape('➜  ~/dir git:(main)')).toBeNull(); // robbyrussell: arrow leads, not trails
    expect(derivePromptShape('')).toBeNull();
  });
});

describe('extractCommand', () => {
  const zsh = { terminator: '%', countBefore: 0 };

  it('slices the command after the zsh terminator and its space', () => {
    expect(extractCommand('ntwigg@ntwigg-mac-2025 mouseterm % pnpm dev:website', zsh)).toBe('pnpm dev:website');
  });

  it('slices the command with no space after the cmd.exe terminator', () => {
    expect(extractCommand('C:\\Users\\ntwigg>dir', { terminator: '>', countBefore: 0 })).toBe('dir');
  });

  it('keeps redirection and command-internal terminators', () => {
    expect(extractCommand('C:\\Users\\ntwigg>dir > out.txt', { terminator: '>', countBefore: 0 })).toBe('dir > out.txt');
    expect(extractCommand('u@h dir % echo 99%', zsh)).toBe('echo 99%');
  });

  it('skips an embedded terminator using countBefore', () => {
    expect(extractCommand('[50%] user dir % echo done', { terminator: '%', countBefore: 1 })).toBe('echo done');
  });

  it('returns null for a bare prompt with nothing typed', () => {
    expect(extractCommand('ntwigg@mac mouseterm % ', zsh)).toBeNull();
  });

  it('returns null when the line lacks enough terminators to be this prompt', () => {
    expect(extractCommand('plain text with no marker', zsh)).toBeNull();
  });
});
