import { beginClipboardAttempt, describeError, noteClipboardStep, reportClipboardFailure, type ClipboardAttempt } from './clipboard-failure';
import { getPlatformOrNull } from './platform/current';

/** Report failure without throwing so callers retain the selection for retry.
 *  The adapter's native write wins where it has one, with no fallback after
 *  it: its round trip outlasts the click's activation, so the browser could
 *  only refuse too. Without one, writes through the Clipboard API, and without
 *  that API (an insecure origin, such as Pocket over plain http) or when it
 *  refuses, through `document.execCommand('copy')`. A write that fails opens
 *  the clipboard-failure report, unless `reportFailure` is false. */
export async function writeTextToClipboard(text: string, { reportFailure = true } = {}): Promise<boolean> {
  if (!text) return false;
  const platform = getPlatformOrNull();
  // Before any await, so the attempt describes, and the fallback runs inside,
  // the click or key that asked.
  const attempt = beginClipboardAttempt(text.length);
  const fail = () => { if (reportFailure) reportClipboardFailure(attempt); return false; };
  if (platform?.writeClipboardText) {
    try {
      await platform.writeClipboardText(text);
      return true;
    } catch (error) {
      noteClipboardStep(attempt, `native writeClipboardText: ${describeError(error)}`);
      return fail();
    }
  }
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard?.writeText) {
    noteClipboardStep(attempt, 'navigator.clipboard.writeText: unavailable');
    return copyWithExecCommand(text, attempt) || fail();
  }
  try {
    await clipboard.writeText(text);
    return true;
  } catch (error) {
    // Denied, or the webview lost focus; the activation may have lapsed too.
    noteClipboardStep(attempt, `navigator.clipboard.writeText: ${describeError(error)} (activation now ${navigator.userActivation?.isActive ?? 'unknown'})`);
    return copyWithExecCommand(text, attempt) || fail();
  }
}

/** Copy `text` through a one-shot `copy` listener, leaving focus where it is:
 *  moving it would blur xterm, which reports the focus change, and commit an
 *  inline rename. WebKit may fire no `copy` without a selection; then a hidden
 *  textarea holds one. */
function copyWithExecCommand(text: string, attempt: ClipboardAttempt): boolean {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') {
    noteClipboardStep(attempt, 'execCommand: unavailable');
    return false;
  }
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
    noteClipboardStep(attempt, `execCommand('copy'): returned ${copied}, copy event ${wrote ? 'fired' : 'did not fire'}`);
    if (wrote) return copied;
  } catch (error) {
    noteClipboardStep(attempt, `execCommand('copy'): ${describeError(error)}`);
    // Fall through to the textarea, which fails the same way if it must.
  } finally {
    document.removeEventListener('copy', onCopy, { capture: true });
  }
  const copied = copyFromTextarea(text);
  noteClipboardStep(attempt, `textarea execCommand('copy'): ${copied}`);
  return copied;
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
