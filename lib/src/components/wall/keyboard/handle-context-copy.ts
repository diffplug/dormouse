import { writeTextToClipboard } from '../../../lib/clipboard';
import { hasCopyModifier } from './chords';

/** Diagnostic DOM selection belongs to context chrome, never its terminal.
 * Supply copy explicitly for the menu-less standalone webview too. */
export function handleContextCopy(event: KeyboardEvent): boolean {
  if (!hasCopyModifier(event) || event.altKey || event.key.toLowerCase() !== 'c') return false;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  const diagnostic = target.closest('[data-context-diagnostic]');
  if (!diagnostic) return false;
  const selection = window.getSelection();
  if (!selection || !diagnostic.contains(selection.anchorNode) || !diagnostic.contains(selection.focusNode)) return false;
  const text = selection.toString();
  if (!text) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  void writeTextToClipboard(text);
  return true;
}
