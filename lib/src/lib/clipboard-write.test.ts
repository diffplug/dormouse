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
import { dismissClipboardFailure, getClipboardFailure } from './clipboard-failure';

/** What each `execCommand('copy')` copied: a `copy` listener's `setData`,
 *  else what a focused textarea had selected. */
let copiedText: string[];
let execCommand: ReturnType<typeof vi.fn>;
/** Whether `execCommand` fires `copy`, as WebKit may not without a selection. */
let firesCopy: boolean;

function stubClipboard(clipboard: Partial<Clipboard> | undefined): void {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
}

beforeEach(() => {
  copiedText = [];
  firesCopy = false;
  execCommand = vi.fn((command: string) => {
    let data: string | undefined;
    if (firesCopy) {
      const event = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { setData: (_type: string, value: string) => { data = value; } } });
      (document.activeElement ?? document.body).dispatchEvent(event);
      if (!event.defaultPrevented) data = undefined;
    }
    const field = document.activeElement;
    if (data !== undefined) copiedText.push(data);
    else if (field instanceof HTMLTextAreaElement) copiedText.push(field.value.slice(field.selectionStart, field.selectionEnd));
    return command === 'copy';
  });
  Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
});

describe('writeTextToClipboard', () => {
  it('writes through the Clipboard API when there is one', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard({ writeText });
    expect(await writeTextToClipboard('hello')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('copies through a copy listener without one, inside the same task, never moving focus', async () => {
    stubClipboard(undefined);
    firesCopy = true;
    const input = document.body.appendChild(document.createElement('input'));
    input.focus();
    const blurred = vi.fn();
    input.addEventListener('blur', blurred);
    const otherHandler = vi.fn();
    input.addEventListener('copy', otherHandler);
    const copied = writeTextToClipboard('two\nlines');
    // Before the caller's click or key returns, while it still grants the copy.
    expect(copiedText).toEqual(['two\nlines']);
    expect(await copied).toBe(true);
    expect(execCommand).toHaveBeenCalledTimes(1);
    expect(blurred).not.toHaveBeenCalled();
    expect(otherHandler).not.toHaveBeenCalled();
    // One-shot: a later copy of the user's own is left alone.
    const own = new Event('copy', { bubbles: true, cancelable: true });
    input.dispatchEvent(own);
    expect(own.defaultPrevented).toBe(false);
  });

  it('copies from a hidden field when no copy event fires, and puts focus back', async () => {
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
    expect(execCommand).toHaveBeenCalledTimes(2);
  });

  it('falls back when the Clipboard API refuses', async () => {
    stubClipboard({ writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) });
    firesCopy = true;
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

describe('clipboard failure report', () => {
  afterEach(() => dismissClipboardFailure());

  it('reports a write refused every way, describing the attempt but never the text', async () => {
    stubClipboard({ writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) });
    execCommand.mockReturnValue(false);
    expect(await writeTextToClipboard('first')).toBe(false);
    const before = getClipboardFailure()!.count;
    expect(await writeTextToClipboard('secret-token')).toBe(false);
    const failure = getClipboardFailure();
    expect(failure?.count).toBe(before + 1);
    expect(failure?.report).toContain('NotAllowedError: denied');
    expect(failure?.report).toContain("execCommand('copy'): returned false");
    expect(failure?.report).toContain('textLength: 12');
    expect(failure?.report).not.toContain('secret-token');
  });

  it('reports nothing when the fallback copies, or when the caller opts out', async () => {
    stubClipboard({ writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) });
    firesCopy = true;
    expect(await writeTextToClipboard('hello')).toBe(true);
    execCommand.mockReturnValue(false);
    firesCopy = false;
    expect(await writeTextToClipboard('hello', { reportFailure: false })).toBe(false);
    expect(getClipboardFailure()).toBeNull();
  });
});
