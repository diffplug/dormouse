import { getMouseSelectionState } from './mouse-selection';
import { rewrap } from './rewrap';
import { extractSelectionText } from './selection-text';
import { getPlatform } from './platform';
import { shellEscapePath } from './shell-escape';
import { getTerminalInstance, markSessionTouched } from './terminal-registry';

async function writeText(text: string): Promise<void> {
  if (!text) return;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
  } catch {
    // Clipboard write can fail when the document lacks focus or the
    // Permissions API denied access. Silently ignore — the user will
    // notice the paste didn't work and can retry.
  }
}

/**
 * Copy the terminal's current selection to the clipboard as-is.
 * No-op if no selection exists.
 */
export async function copyRaw(terminalId: string): Promise<void> {
  const terminal = getTerminalInstance(terminalId);
  const sel = getMouseSelectionState(terminalId).selection;
  if (!terminal || !sel) return;
  await writeText(extractSelectionText(terminal, sel));
}

/**
 * Copy the terminal's current selection with rewrap transformations applied.
 * Block selections are not rewrapped (they're intentionally rectangular slabs).
 * No-op if no selection exists.
 */
export async function copyRewrapped(terminalId: string): Promise<void> {
  const terminal = getTerminalInstance(terminalId);
  const sel = getMouseSelectionState(terminalId).selection;
  if (!terminal || !sel) return;
  const raw = extractSelectionText(terminal, sel);
  const out = sel.shape === 'block' ? raw : rewrap(raw);
  await writeText(out);
}

function writePasteToPty(terminalId: string, text: string): void {
  if (!text) return;
  const bracketed = getMouseSelectionState(terminalId).bracketedPaste;
  const payload = bracketed ? `\x1b[200~${text}\x1b[201~` : text;
  markSessionTouched(terminalId);
  getPlatform().writePty(terminalId, payload);
}

/**
 * Shell-escape the given paths and type them at the terminal, joined by single
 * spaces with a trailing space so the next prompt keystroke starts a fresh
 * token.
 */
export function pasteFilePaths(terminalId: string, paths: string[]): void {
  if (paths.length === 0) return;
  const text = paths.map(shellEscapePath).join(' ') + ' ';
  writePasteToPty(terminalId, text);
}

export async function readTextFromClipboard(): Promise<string> {
  // Prefer the platform's native text read when available — navigator.clipboard.readText()
  // on macOS WKWebView pops a "Paste from <App>" confirmation menu at the cursor every
  // time it's invoked from JS, which defeats the point of a paste shortcut.
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

/**
 * Read the clipboard and write its contents to the PTY, honoring the inside
 * program's bracketed-paste mode when enabled (spec §8.5). Prefers file
 * references over plain text (a Finder Cmd+V types the path, not "Document.pdf"
 * as a name string), with raw images saved to a temp file as a last resort.
 *
 * File-path and text reads run in parallel since they're independent IPC
 * roundtrips; the image read is sequential because it allocates a temp file.
 */
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
