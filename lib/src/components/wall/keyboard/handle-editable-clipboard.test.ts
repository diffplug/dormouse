/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleEditableClipboard } from './handle-editable-clipboard';
import { FakePtyAdapter } from '../../../lib/platform/fake-adapter';
import { setPlatform } from '../../../lib/platform';
import type { PlatformAdapter } from '../../../lib/platform/types';

let platform: FakePtyAdapter;
let writeText: ReturnType<typeof vi.fn>;

/** The menu-less standalone host is the one that needs JS clipboard chords, and
 *  a native `readClipboardText` is what identifies it. */
function withNativeClipboardRead(text: string): void {
  (platform as PlatformAdapter).readClipboardText = vi.fn(async () => text);
}

function field(value: string, selection: [number, number]): HTMLInputElement {
  const input = document.createElement('input');
  input.value = value;
  document.body.appendChild(input);
  input.focus();
  input.setSelectionRange(selection[0], selection[1]);
  return input;
}

function chord(target: HTMLElement, key: string, mod: 'meta' | 'ctrl'): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key,
    metaKey: mod === 'meta',
    ctrlKey: mod === 'ctrl',
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(e, 'target', { value: target });
  return e;
}

beforeEach(() => {
  platform = new FakePtyAdapter();
  setPlatform(platform);
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  document.body.innerHTML = '';
  // jsdom ships no execCommand; the cases that stub one must not leak it.
  delete (document as Partial<Document>).execCommand;
  platform.reset();
});

describe('handleEditableClipboard', () => {
  it('pastes over the selection and reports the edit to React', async () => {
    withNativeClipboardRead('pasted');
    const input = field('old-title', [0, 'old-title'.length]);
    const onInput = vi.fn();
    input.addEventListener('input', onInput);

    const e = chord(input, 'v', 'meta');
    expect(handleEditableClipboard(e)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(input.value).toBe('pasted'));
    expect(input.selectionStart).toBe('pasted'.length);
    expect(onInput).toHaveBeenCalled();
  });

  it('pastes at the caret when nothing is selected', async () => {
    withNativeClipboardRead('-mid');
    const input = field('ab', [1, 1]);

    handleEditableClipboard(chord(input, 'v', 'ctrl'));
    await vi.waitFor(() => expect(input.value).toBe('a-midb'));
  });

  it('stands down on hosts whose webview still has native chords', () => {
    const input = field('title', [0, 5]);

    expect(handleEditableClipboard(chord(input, 'v', 'meta'))).toBe(false);
    expect(handleEditableClipboard(chord(input, 'c', 'ctrl'))).toBe(false);
  });

  it("leaves the terminal's own input proxy alone", () => {
    withNativeClipboardRead('pasted');
    const proxy = document.createElement('textarea');
    proxy.className = 'xterm-helper-textarea';
    document.body.appendChild(proxy);

    expect(handleEditableClipboard(chord(proxy, 'v', 'meta'))).toBe(false);
  });

  it('copies the selection, and cut also removes it', async () => {
    withNativeClipboardRead('');
    const input = field('one two', [4, 7]);

    expect(handleEditableClipboard(chord(input, 'c', 'ctrl'))).toBe(true);
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('two'));
    expect(input.value).toBe('one two');

    handleEditableClipboard(chord(input, 'x', 'ctrl'));
    await vi.waitFor(() => expect(input.value).toBe('one '));
  });

  it('drops the edit when the field unmounts during the clipboard read', async () => {
    // Escape, or the blur that commits a rename, can retire the field while the
    // host's clipboard IPC is still in flight. `execCommand` would then edit
    // whatever holds focus — usually the terminal — so nothing must land.
    let deliverClipboard!: (text: string) => void;
    (platform as PlatformAdapter).readClipboardText = () =>
      new Promise<string>((resolve) => { deliverClipboard = resolve; });
    const input = field('old-title', [0, 'old-title'.length]);
    const survivor = field('elsewhere', [0, 0]);
    const insertText = vi.fn(() => true);
    document.execCommand = insertText as unknown as typeof document.execCommand;

    handleEditableClipboard(chord(input, 'v', 'meta'));
    input.remove();
    deliverClipboard('pasted');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(insertText).not.toHaveBeenCalled();
    expect(input.value).toBe('old-title');
    expect(survivor.value).toBe('elsewhere');
  });

  it('prefers execCommand insertText when the webview provides it', async () => {
    // jsdom has no execCommand, so every other case here exercises the manual
    // fallback; this pins the branch that actually runs in production, cut's
    // empty-string delete included.
    withNativeClipboardRead('pasted');
    const insertText = vi.fn(() => true);
    document.execCommand = insertText as unknown as typeof document.execCommand;
    const input = field('one two', [4, 7]);

    handleEditableClipboard(chord(input, 'v', 'meta'));
    await vi.waitFor(() => expect(insertText).toHaveBeenCalledWith('insertText', false, 'pasted'));

    handleEditableClipboard(chord(input, 'x', 'ctrl'));
    await vi.waitFor(() => expect(insertText).toHaveBeenCalledWith('insertText', false, ''));
  });

  it('copies nothing when the selection is collapsed', () => {
    withNativeClipboardRead('pasted');
    const input = field('title', [2, 2]);

    handleEditableClipboard(chord(input, 'c', 'ctrl'));
    expect(writeText).not.toHaveBeenCalled();
  });

  it('passes non-clipboard chords through', () => {
    withNativeClipboardRead('pasted');
    const input = field('title', [0, 5]);

    expect(handleEditableClipboard(chord(input, 'a', 'ctrl'))).toBe(false);
  });

  it('passes an unmodified key through', () => {
    withNativeClipboardRead('pasted');
    const input = field('title', [0, 5]);

    const bare = new KeyboardEvent('keydown', { key: 'v' });
    Object.defineProperty(bare, 'target', { value: input });
    expect(handleEditableClipboard(bare)).toBe(false);
  });
});
