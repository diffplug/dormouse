import { describe, expect, it } from 'vitest';
import { createPromptSubmitState, detectPromptSubmit } from './terminal-command-input';

describe('terminal prompt submit detection', () => {
  it('detects Enter as a submit', () => {
    expect(detectPromptSubmit(createPromptSubmitState(), 'lazygit\r').submitted).toBe(true);
    expect(detectPromptSubmit(createPromptSubmitState(), '\n').submitted).toBe(true);
  });

  it('does not submit on ordinary typing', () => {
    const result = detectPromptSubmit(createPromptSubmitState(), 'pnpm dev');
    expect(result.submitted).toBe(false);
    expect(result.state.inPaste).toBe(false);
  });

  it('ignores newlines inside a bracketed paste', () => {
    const result = detectPromptSubmit(createPromptSubmitState(), '\x1b[200~line one\nline two\x1b[201~');
    expect(result.submitted).toBe(false);
  });

  it('submits on the Enter that follows a multiline paste', () => {
    const result = detectPromptSubmit(createPromptSubmitState(), '\x1b[200~a\nb\x1b[201~\r');
    expect(result.submitted).toBe(true);
  });

  it('carries the in-paste state across chunk boundaries', () => {
    const first = detectPromptSubmit(createPromptSubmitState(), '\x1b[200~first line\n');
    expect(first.submitted).toBe(false);
    expect(first.state.inPaste).toBe(true);

    const second = detectPromptSubmit(first.state, 'second line\x1b[201~\r');
    expect(second.submitted).toBe(true);
    expect(second.state.inPaste).toBe(false);
  });
});
