import { readTextFromClipboard, writeTextToClipboard } from '../../../lib/clipboard';
import { isTerminalInputProxy, setNativeFieldValue } from '../../../lib/dom';
import { getPlatform } from '../../../lib/platform';
import { hasCopyModifier, hasPasteModifier } from './chords';

type TextField = HTMLInputElement | HTMLTextAreaElement;

/**
 * Cmd/Ctrl + C / X / V inside one of our own text fields — pane rename, the
 * browser URL editor, dialog inputs.
 *
 * The standalone host replaces macOS's default menu so its native Paste item
 * stops fighting the terminal's DOM-level Cmd+V (`standalone/src-tauri/src/lib.rs`),
 * and WKWebView routes clipboard chords through that menu — so with it gone,
 * copy/cut/paste do nothing in any DOM input there. This restores them in JS.
 * The gate is the adapter's optional `readClipboardText`, today the two
 * standalone adapters — the menu-less macOS build this is written for, plus the
 * Chrome dev harness, where the JS path simply replaces a working native one.
 * Everywhere else (VS Code, the website, Pocket) the native chords are left
 * alone (`docs/specs/mouse-and-clipboard.md` §8.9).
 *
 * Alone among the `handle-*` dispatch modules it takes no `WallKeyboardCtx`: a
 * focused text field owns these chords whatever mode the wall is in, and xterm's
 * input proxy — the one editable element that is the terminal's — is excluded by
 * name. Returns true if handled.
 */
export function handleEditableClipboard(e: KeyboardEvent): boolean {
  if (!hasPasteModifier(e) || e.altKey) return false;
  const key = e.key.toLowerCase();
  if (key !== 'c' && key !== 'x' && key !== 'v') return false;
  if (key !== 'v' && !hasCopyModifier(e)) return false;
  // Cheapest decisive gate first: on a host with native chords this is false for
  // the whole session, so it never pays for the DOM inspection below.
  if (!getPlatform().readClipboardText) return false;

  const el = e.target;
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
  if (isTerminalInputProxy(el) || el.readOnly || el.disabled) return false;

  e.preventDefault();
  e.stopImmediatePropagation();
  if (key === 'v') void pasteIntoField(el);
  else void copyFromField(el, key === 'x');
  return true;
}

async function pasteIntoField(el: TextField): Promise<void> {
  const text = await readTextFromClipboard();
  if (!text) return;
  replaceSelection(el, text);
}

async function copyFromField(el: TextField, cut: boolean): Promise<void> {
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  if (start === end) return;
  await writeTextToClipboard(el.value.slice(start, end));
  if (cut) replaceSelection(el, '');
}

function replaceSelection(el: TextField, text: string): void {
  // Both callers await the clipboard first — an IPC roundtrip on the standalone
  // host — and the field can unmount in that window (Escape, or the blur that
  // commits a rename). `execCommand` edits whatever is focused *now*, which by
  // then is often xterm's helper textarea, so an unguarded edit would type the
  // clipboard into the shell.
  if (!el.isConnected) return;
  el.focus();
  // `insertText` is the only edit that also lands in the native undo stack, but
  // it is deprecated and absent in some environments — fall through to the
  // manual edit when it is unavailable or refuses.
  if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) return;

  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  setNativeFieldValue(el, `${el.value.slice(0, start)}${text}${el.value.slice(end)}`);
  const caret = start + text.length;
  el.setSelectionRange(caret, caret);
}
