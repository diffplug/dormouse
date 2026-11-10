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

  it('recognizes paste markers split at every byte boundary', () => {
    const paste = '\x1b[200~first\nsecond\x1b[201~';
    for (let split = 1; split < paste.length; split++) {
      const first = detectPromptSubmit(createPromptSubmitState(), paste.slice(0, split));
      const second = detectPromptSubmit(first.state, paste.slice(split));
      expect(first.submitted).toBe(false);
      expect(second.submitted).toBe(false);
      expect(second.state.inPaste).toBe(false);
      expect(detectPromptSubmit(second.state, '\r').submitted).toBe(true);
    }
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

describe('win32-input-mode submit detection', () => {
  // `ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`, as xterm.js encodes a key under `CSI ? 9001 h`.
  const key = (vk: number, uc: number, down: boolean, cs = 0) => `\x1b[${vk};28;${uc};${down ? 1 : 0};${cs};1_`;
  const enterDown = (cs = 0) => key(13, cs & 0b1100 ? 10 : 13, true, cs);
  const submits = (input: string) => detectPromptSubmit(createPromptSubmitState(), input).submitted;

  it('submits on an Enter key-down record, and only once with its key-up', () => {
    expect(submits(enterDown())).toBe(true);
    expect(submits(key(13, 13, false))).toBe(false);
    expect(submits(key(68, 100, true) + key(68, 100, false) + enterDown() + key(13, 13, false))).toBe(true);
  });

  it('submits on Shift+Enter, Alt+Enter, and numpad Enter, as cmd.exe does', () => {
    expect(submits(enterDown(0b10000))).toBe(true); // SHIFT_PRESSED
    expect(submits(enterDown(0b10))).toBe(true); // LEFT_ALT_PRESSED
    expect(submits(enterDown(0b100000000))).toBe(true); // ENHANCED_KEY
    expect(submits(enterDown(0b10100000))).toBe(true); // NUMLOCK_ON | CAPSLOCK_ON
  });

  it('does not submit on Ctrl+Enter', () => {
    expect(submits(enterDown(0b1000))).toBe(false); // LEFT_CTRL_PRESSED
    expect(submits(enterDown(0b100))).toBe(false); // RIGHT_CTRL_PRESSED
  });

  it('does not submit on other keys, including VK_RETURN-like unicode fields', () => {
    expect(submits(key(68, 100, true))).toBe(false);
    expect(submits(key(77, 13, true, 0b1000))).toBe(false); // Ctrl+M carries uc 13
  });

  it('does not submit on an Enter record inside a bracketed paste', () => {
    expect(submits(`\x1b[200~a${enterDown()}b\x1b[201~`)).toBe(false);
  });
});
