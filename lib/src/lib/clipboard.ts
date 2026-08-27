import { shellCommandKind } from 'dor/commands/shell-quote';
import { getMouseSelectionState } from './mouse-selection';
import { rewrap } from './rewrap';
import { extractSelectionText } from './selection-text';
import { getPlatform, PLATFORM_STRING } from './platform';
import { shellEscapePath } from './shell-escape';
import { getDefaultShellOpts, getTerminalInstance, getTerminalShellKind, markSessionTouched } from './terminal-registry';

/** Write plain text to the system clipboard, swallowing the failures a webview
 *  raises when the document lacks focus or the Permissions API said no — the
 *  user sees nothing was copied and retries. */
export async function writeTextToClipboard(text: string): Promise<void> {
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
  await writeTextToClipboard(extractSelectionText(terminal, sel));
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
  await writeTextToClipboard(out);
}

/**
 * Neutralize every ESC in a bracketed-paste payload, rendering each as a
 * visible U+241B. Without this, clipboard content holding `\x1b[201~` closes
 * the bracket early and everything after it arrives as ordinary typed input —
 * newlines included, which submit. A hostile page that can put text on the
 * clipboard would then be able to run a command the user never pasted.
 *
 * This is byte-for-byte what xterm's own `bracketTextForPaste` does; we have to
 * repeat it because `writePasteToPty` writes to the PTY directly and so never
 * reaches it (see the comment below). Replacing rather than stripping keeps the
 * paste visible: the user sees that something was defanged instead of watching
 * bytes vanish.
 *
 * Only the bracketed branch is filtered. Without brackets the inside program has
 * not asked to tell pasted bytes from typed ones, so there is no boundary left
 * to protect and filtering would only break deliberate pastes of escape
 * sequences — again matching xterm.
 */
function defangPasteEscapes(text: string): string {
  return text.replace(/\x1b/g, '\u241b');
}

function writePasteToPty(terminalId: string, text: string): void {
  if (!text) return;
  const bracketed = getMouseSelectionState(terminalId).bracketedPaste;
  const payload = bracketed ? `\x1b[200~${defangPasteEscapes(text)}\x1b[201~` : text;
  // Paste and file-drop input bypass xterm's onData handler, so the touch has to
  // be marked here rather than by the keystroke path.
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
  // A Session keeps the shell family it launched with even after the user picks
  // a different app-global default for future terminals. The fallback only
  // serves adapters/tests that have no registered Session entry.
  const shellKind = getTerminalShellKind(terminalId)
    ?? shellCommandKind(getDefaultShellOpts()?.shell, PLATFORM_STRING);
  const text = paths.map((path) => shellEscapePath(path, shellKind)).join(' ') + ' ';
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
