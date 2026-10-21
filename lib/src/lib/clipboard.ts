import { hasShellInputControls, shellCommandKind } from 'dor/commands/shell-quote';
import { wallHandleOwning } from '../components/wall/wall-handles';
import { getMouseSelectionState } from './mouse-selection';
import { getPlatform, PLATFORM_STRING } from './platform';
import { shellEscapePath } from './shell-escape';
import { getDefaultShellOpts, getTerminalShellKind, writeUserInput } from './terminal-registry';

// Kept in its own module so a component that only copies text (CopyButton)
// does not pull in the terminal stack this one carries.
export { writeTextToClipboard } from './clipboard-write';

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
export const UNQUOTABLE_PATH_NOTICE = 'Nothing pasted: a file name has a character cmd or PowerShell would expand';

/**
 * Shell-escape the given paths and type them at the terminal, joined by single
 * spaces with a trailing space so the next prompt keystroke starts a fresh
 * token. A path carrying a control character, or one with no form its
 * Session's shells all read literally, refuses the whole paste (spec §8.6).
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
  const escaped = paths.map((path) => shellEscapePath(path, shellKind));
  if (escaped.some((path) => path === null)) {
    wallHandleOwning(terminalId)?.showNotice(UNQUOTABLE_PATH_NOTICE, terminalId);
    return;
  }
  writePasteToPty(terminalId, escaped.join(' ') + ' ');
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

/** Paste supplied native-event text, or read file references, text, then an image temp path.
 * The first two are read in parallel; the image only once both are empty,
 * since reading it allocates a temp file. */
export async function doPaste(terminalId: string, suppliedText?: string): Promise<void> {
  if (suppliedText !== undefined) {
    writePasteToPty(terminalId, suppliedText);
    return;
  }
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
