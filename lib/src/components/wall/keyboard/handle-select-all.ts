import { isEditableTarget, isTerminalInputProxy } from '../../../lib/dom';
import { IS_MAC } from '../../../lib/platform';

/** Cancels ⌘A outside a text field of ours, so the standalone macOS Edit
 *  menu's Select All never selects the UI (docs/specs/standalone.md →
 *  "Application menu"), and keeps it from xterm.js, whose own macOS select-all
 *  would highlight the whole buffer around the terminal-owned selection. The
 *  key still runs through the rest of the Wall's dispatch, and a focused iframe
 *  never reaches this listener, so Tools keep Select All. */
export function cancelUiSelectAll(e: KeyboardEvent): void {
  if (!IS_MAC || !e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== 'a') return;
  if (isTerminalInputProxy(e.target)) e.stopPropagation();
  else if (isEditableTarget(e.target)) return;
  e.preventDefault();
}
