import { shellCommandKind } from 'dor/commands/shell-quote';
import { getMouseSelectionState } from './mouse-selection';
import { rewrap } from './rewrap';
import { extractSelectionText } from './selection-text';
import { getPlatform, PLATFORM_STRING } from './platform';
import { shellEscapePath } from './shell-escape';
import { getDefaultShellOpts, getTerminalInstance, getTerminalShellKind, writeUserInput } from './terminal-registry';

/** Report failure without throwing so callers retain the selection for retry. */
export async function writeTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Clipboard access can be denied or the webview can lose focus.
  }
  return false;
}

/** Copy the current selection as-is; no-op without one. */
export async function copyRaw(terminalId: string): Promise<boolean> {
  const terminal = getTerminalInstance(terminalId);
  const sel = getMouseSelectionState(terminalId).selection;
  if (!terminal || !sel) return false;
  return writeTextToClipboard(extractSelectionText(terminal, sel));
}

/** Copy with rewrap, except for rectangular block selections. */
export async function copyRewrapped(terminalId: string): Promise<boolean> {
  const terminal = getTerminalInstance(terminalId);
  const sel = getMouseSelectionState(terminalId).selection;
  if (!terminal || !sel) return false;
  const raw = extractSelectionText(terminal, sel);
  const out = sel.shape === 'block' ? raw : rewrap(raw);
  return writeTextToClipboard(out);
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

/**
 * Shell-escape the given paths and type them at the terminal, joined by single
 * spaces with a trailing space so the next prompt keystroke starts a fresh
 * token.
 */
export function pasteFilePaths(terminalId: string, paths: string[]): void {
  if (paths.length === 0) return;
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
