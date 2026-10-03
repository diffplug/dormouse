import { isEditableTarget } from '../../../lib/dom';
import { isMacSelectAll } from '../../../lib/select-all';

/** docs/specs/mouse-and-clipboard.md → "3.9 Select All". The terminal's input
 *  proxy counts as editable here; its xterm key handler cancels ⌘A itself. */
export function cancelUiSelectAll(e: KeyboardEvent): void {
  if (isMacSelectAll(e) && !isEditableTarget(e.target)) e.preventDefault();
}
