import { describe, expect, it } from 'vitest';
import {
  createPromptCommandInputState,
  updatePromptCommandInput,
} from './terminal-command-input';

describe('terminal prompt command input tracker', () => {
  it('submits a simple typed command on enter', () => {
    const result = updatePromptCommandInput(createPromptCommandInputState(), 'lazygit\r');

    expect(result.submittedCommandLine).toBe('lazygit');
    expect(result.state).toEqual(createPromptCommandInputState());
  });

  it('tracks basic prompt editing before enter', () => {
    let result = updatePromptCommandInput(createPromptCommandInputState(), 'lazygi');
    result = updatePromptCommandInput(result.state, 'x\x7ft\r');

    expect(result.submittedCommandLine).toBe('lazygit');
  });

  it('keeps cursor-aware edits for left and right arrow input', () => {
    let result = updatePromptCommandInput(createPromptCommandInputState(), 'lazgit');
    result = updatePromptCommandInput(result.state, '\x1b[D\x1b[D\x1b[D');
    result = updatePromptCommandInput(result.state, 'y\r');

    expect(result.submittedCommandLine).toBe('lazygit');
  });

  it('does not trust history navigation because the visible line is shell-owned', () => {
    const result = updatePromptCommandInput(createPromptCommandInputState(), '\x1b[A\r');

    expect(result.submittedCommandLine).toBeNull();
  });

  it('ignores bracketed paste delimiters while keeping pasted command text', () => {
    const result = updatePromptCommandInput(createPromptCommandInputState(), '\x1b[200~pnpm test\x1b[201~\r');

    expect(result.submittedCommandLine).toBe('pnpm test');
  });
});
