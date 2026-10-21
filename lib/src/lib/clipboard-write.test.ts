/**
 * @vitest-environment jsdom
 *
 * `writeTextToClipboard`: the adapter's native write where it has one, else
 * the Clipboard API, falling back for a page without it, such as Pocket over
 * plain http (docs/specs/mouse-and-clipboard.md §4.5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The installed adapter's native write; absent unless a test sets it. */
let nativeWrite: ((text: string) => Promise<void>) | undefined;
vi.mock('./platform/current', () => {
  const platform = () => (nativeWrite ? { writeClipboardText: nativeWrite } : {});
  return { getPlatform: platform, getPlatformOrNull: platform };
});

import { writeTextToClipboard } from './clipboard-write';
import { dismissClipboardFailure, getClipboardFailure, recordInput } from './clipboard-failure';

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
  nativeWrite = undefined;
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

  it('prefers the adapter\'s native write over the Clipboard API', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard({ writeText });
    nativeWrite = vi.fn(() => Promise.resolve());
    expect(await writeTextToClipboard('hello')).toBe(true);
    expect(nativeWrite).toHaveBeenCalledWith('hello');
    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('never falls back to the browser after a native write fails', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard({ writeText });
    firesCopy = true;
    nativeWrite = vi.fn(() => Promise.reject(new Error('pbcopy exited 1')));
    expect(await writeTextToClipboard('hello', { reportFailure: false })).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
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

  it('reports the latest trusted inputs with the activation each arrived with', async () => {
    const button = document.body.appendChild(document.createElement('button'));
    button.className = 'copy-target extra';
    Object.defineProperty(navigator, 'userActivation', { value: { isActive: true, hasBeenActive: true }, configurable: true });
    try {
      recordInput({ type: 'pointerdown', isTrusted: true, target: button });
      recordInput({ type: 'mousedown', isTrusted: false, target: button });
      (navigator.userActivation as { isActive: boolean }).isActive = false;
      recordInput({ type: 'click', isTrusted: true, target: button });
      nativeWrite = () => Promise.reject(new Error('refused'));
      expect(await writeTextToClipboard('hello')).toBe(false);
      const lines = getClipboardFailure()!.report.split('\n');
      const timeline = lines.slice(lines.findIndex(line => line.startsWith('input timeline')) + 1).filter(line => line.startsWith('  -'));
      expect(timeline.slice(-2).map(line => line.replace(/^ {2}-\d+ms /, ''))).toEqual([
        'pointerdown button.copy-target active=true',
        'click button.copy-target active=false',
      ]);
    } finally {
      Reflect.deleteProperty(navigator, 'userActivation');
      button.remove();
    }
  });

  it('reports a failed native write with its error', async () => {
    nativeWrite = () => Promise.reject(new Error('pbcopy exited 1'));
    expect(await writeTextToClipboard('secret-token')).toBe(false);
    const failure = getClipboardFailure();
    expect(failure?.report).toContain('native writeClipboardText: Error: pbcopy exited 1');
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
