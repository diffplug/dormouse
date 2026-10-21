import type { IMarker, Terminal } from '@xterm/xterm';
import { followCopySelection } from './copy-editor';
import { spanOfSelection } from './copy-text';
import { getMouseSelectionState, setSelection, subscribeToMouseSelection, type Selection } from './mouse-selection';
import { anchorSelection, followReflow, markRow, type ReflowAnchor } from './selection-reflow';
import { extractSelectionText } from './selection-text';

// A pane's selection held to the characters under it
// (docs/specs/mouse-and-clipboard.md §3.4), its readings retaken whenever
// anyone finalizes or moves it.

export interface SelectionWatch {
  /** After each xterm render. */
  onRender(): void;
  /** After each terminal resize. */
  onResize(): void;
  dispose(): void;
}

export function watchSelection(id: string, terminal: Terminal): SelectionWatch {
  let selection: Selection | null = null;
  /** Its text while finalized, compared on every render. */
  let baseline: string | null = null;
  /** Its edges, carried through a resize's reflow. */
  let anchor: ReflowAnchor | null = null;
  // A full normal buffer trims its oldest rows as output arrives. One marker
  // on the earlier edge distinguishes translation from replacement text.
  let scrollMarker: IMarker | null = null;
  /** While {@link onRender} follows a trim: the text matched and every marker
   *  moved with it, so its write needs no fresh readings. */
  let following = false;
  const unsubscribe = subscribeToMouseSelection(() => {
    const sel = getMouseSelectionState(id).selection;
    if (sel === selection) return;
    selection = sel;
    if (following) return;
    baseline = sel && !sel.dragging ? extractSelectionText(terminal, sel) : null;
    anchor?.dispose();
    anchor = sel && anchorSelection(terminal, sel);
    scrollMarker?.dispose();
    scrollMarker = sel && !sel.dragging && terminal.buffer.active.type === 'normal'
      ? markRow(terminal, Math.min(sel.startRow, sel.endRow)) : null;
  });
  return {
    onRender() {
      if (!selection || baseline === null) return;
      if (scrollMarker?.isDisposed) { setSelection(id, null); return; }
      const shift = scrollMarker ? scrollMarker.line - Math.min(selection.startRow, selection.endRow) : 0;
      const moved = shift ? { ...selection, startRow: selection.startRow + shift, endRow: selection.endRow + shift } : selection;
      if (extractSelectionText(terminal, moved) !== baseline) setSelection(id, null);
      else if (moved !== selection) {
        following = true;
        try { followCopySelection(id, terminal, spanOfSelection(moved)); } finally { following = false; }
      }
    },
    onResize() {
      const span = anchor && followReflow(terminal, anchor);
      if (span) followCopySelection(id, terminal, span);
      else setSelection(id, null);
    },
    dispose() {
      unsubscribe();
      anchor?.dispose();
      scrollMarker?.dispose();
    },
  };
}
