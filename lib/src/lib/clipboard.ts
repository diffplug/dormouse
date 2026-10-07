import { hasShellInputControls, shellCommandKind } from 'dor/commands/shell-quote';
import { wallHandleOwning } from '../components/wall/wall-handles';
import { getMouseSelectionState } from './mouse-selection';
import { getPlatform, PLATFORM_STRING } from './platform';
import { shellEscapePath } from './shell-escape';
import { getDefaultShellOpts, getTerminalShellKind, writeUserInput } from './terminal-registry';

/** Report failure without throwing so callers retain the selection for retry.
 *  Without the Clipboard API (an insecure origin, such as Pocket over plain
 *  http) or when it refuses, falls back to `document.execCommand('copy')`. */
export async function writeTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  // Before any await, so the fallback runs inside the click or key that asked.
  if (!clipboard?.writeText) return copyWithExecCommand(text);
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    // Denied, or the webview lost focus; the activation may have lapsed too.
    return copyWithExecCommand(text);
  }
}

/** Copy `text` through a one-shot `copy` listener, leaving focus where it is:
 *  moving it would blur xterm, which reports the focus change, and commit an
 *  inline rename. WebKit may fire no `copy` without a selection; then a hidden
 *  textarea holds one. */
function copyWithExecCommand(text: string): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  let wrote = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    // Ours alone: no other copy handler writes over it.
    event.stopImmediatePropagation();
    wrote = true;
  };
  document.addEventListener('copy', onCopy, { capture: true });
  try {
    const copied = document.execCommand('copy');
    if (wrote) return copied;
  } catch {
    // Fall through to the textarea, which fails the same way if it must.
  } finally {
    document.removeEventListener('copy', onCopy, { capture: true });
  }
  return copyFromTextarea(text);
}

/** Copy `text` from a hidden textarea, putting focus back after; a field
 *  keeps its own selection through the blur. */
function copyFromTextarea(text: string): boolean {
  const previous = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute('aria-hidden', 'true');
  // Off-screen rather than hidden, which cannot be selected; 16px type keeps
  // iOS from zooming to it.
  Object.assign(textarea.style, { position: 'fixed', top: '0', left: '-9999px', opacity: '0', fontSize: '16px' });
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
    if (previous instanceof HTMLElement) previous.focus({ preventScroll: true });
  }
}

/** Replace ESC with visible U+241B so clipboard text cannot close a bracketed
 * paste early. Never apply this to unbracketed input; see spec §8.5. */
function defangPasteEscapes(text: string): string {
  return text.replace(/\x1b/g, '\u241b');
}

function writePasteToPty(terminalId: string, text: string): void {
  if (!text) return;
  const bracketed = getMouseSelectionState(terminalId).bracketedPaste;
  const payload = bracketed ? `\x1b[200~${defangPasteEscapes(text)}\x1b[201~` : text;
  // Paste and file-drop input bypass xterm's onData handler, so they take the
  // keystroke path's write here: touched, acknowledged, then written.
  writeUserInput(terminalId, payload);
}

export const CONTROL_PATH_NOTICE = 'Nothing pasted: a file name has a control character';

/**
 * Shell-escape the given paths and type them at the terminal, joined by single
 * spaces with a trailing space so the next prompt keystroke starts a fresh
 * token. A path carrying a control character refuses the whole paste (spec §8.6).
 */
export function pasteFilePaths(terminalId: string, paths: string[]): void {
  if (paths.length === 0) return;
  if (paths.some(hasShellInputControls)) {
    wallHandleOwning(terminalId)?.showNotice(CONTROL_PATH_NOTICE, terminalId);
    return;
  }
  // A Session keeps the shell family it launched with even after the user picks
  // a different app-global default for future terminals. The fallback only
  // serves adapters/tests that have no registered Session entry.
  const shellKind = getTerminalShellKind(terminalId)
    ?? shellCommandKind(getDefaultShellOpts()?.shell, PLATFORM_STRING);
  const text = paths.map((path) => shellEscapePath(path, shellKind)).join(' ') + ' ';
  writePasteToPty(terminalId, text);
}

export async function readTextFromClipboard(): Promise<string> {
  // Prefer native reads; macOS WKWebView prompts on every navigator read.
  const platform = getPlatform();
  if (platform.readClipboardText) {
    try {
      return (await platform.readClipboardText()) ?? '';
    } catch {
      return '';
    }
  }
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return '';
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}

/** Paste file references, then text, then an image temp path; spec §8.6 owns
 * priority and concurrency. */
export async function doPaste(terminalId: string): Promise<void> {
  const platform = getPlatform();

  const [paths, text] = await Promise.all([
    platform.readClipboardFilePaths().catch(() => null),
    readTextFromClipboard(),
  ]);
  if (paths && paths.length > 0) {
    pasteFilePaths(terminalId, paths);
    return;
  }
  if (text) {
    writePasteToPty(terminalId, text);
    return;
  }

  const imagePath = await platform.readClipboardImageAsFilePath().catch(() => null);
  if (imagePath) {
    pasteFilePaths(terminalId, [imagePath]);
  }
}
