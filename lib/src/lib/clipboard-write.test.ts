/**
 * @vitest-environment jsdom
 *
 * `writeTextToClipboard`'s fallback for a page without the Clipboard API, such
 * as Pocket over plain http (docs/specs/mouse-and-clipboard.md §4.5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./platform', () => ({ IS_MAC: false, IS_WINDOWS: false, PLATFORM_STRING: 'Linux', getPlatform: () => ({}) }));
vi.mock('./mouse-selection', () => ({ getMouseSelectionState: () => ({ bracketedPaste: false }) }));
vi.mock('./terminal-registry', () => ({ getDefaultShellOpts: () => null, getTerminalShellKind: () => null, writeUserInput: () => {} }));

import { writeTextToClipboard } from './clipboard';

/** What `execCommand('copy')` saw selected, each time it ran. */
let copiedText: string[];
let execCommand: ReturnType<typeof vi.fn>;

function stubClipboard(clipboard: Partial<Clipboard> | undefined): void {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
}

beforeEach(() => {
  copiedText = [];
  execCommand = vi.fn((command: string) => {
    const field = document.activeElement as HTMLTextAreaElement;
    copiedText.push(field.value.slice(field.selectionStart, field.selectionEnd));
    return command === 'copy';
  });
  Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
});

afterEach(() => {
  stubClipboard(undefined);
  document.body.replaceChildren();
});

describe('writeTextToClipboard', () => {
  it('writes through the Clipboard API when there is one', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard({ writeText });
    expect(await writeTextToClipboard('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('copies from a hidden field without one, inside the same task, and puts focus back', async () => {
    stubClipboard(undefined);
    const input = document.body.appendChild(document.createElement('input'));
    input.value = 'draft';
    input.focus();
    input.setSelectionRange(1, 3);
    const copied = writeTextToClipboard('two\nlines');
    // Before the caller's click or key returns, while it still grants the copy.
    expect(copiedText).toEqual(['two\nlines']);
    expect(await copied).toBe(true);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('falls back when the Clipboard API refuses', async () => {
    stubClipboard({ writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) });
    expect(await writeTextToClipboard('hello')).toBe(true);
    expect(copiedText).toEqual(['hello']);
  });

  it('reports failure when the fallback fails too', async () => {
    stubClipboard(undefined);
    execCommand.mockReturnValue(false);
    expect(await writeTextToClipboard('hello')).toBe(false);
    execCommand.mockImplementation(() => { throw new Error('unsupported'); });
    expect(await writeTextToClipboard('hello')).toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('writes nothing for empty text', async () => {
    stubClipboard(undefined);
    expect(await writeTextToClipboard('')).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
  });
});
