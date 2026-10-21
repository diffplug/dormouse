import type { IMarker, Terminal } from '@xterm/xterm';
import { followCopySelection } from './copy-editor';
import { spanOfSelection } from './copy-text';
import { getMouseSelectionState, setSelection, subscribeToMouseSelection, type Selection } from './mouse-selection';
import { anchorSelection, followReflow, type ReflowAnchor } from './selection-reflow';
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
  let scrollAnchor: { marker: IMarker; row: number } | null = null;
  const unsubscribe = subscribeToMouseSelection(() => {
    const sel = getMouseSelectionState(id).selection;
    if (sel === selection) return;
    selection = sel;
    baseline = sel && !sel.dragging ? extractSelectionText(terminal, sel) : null;
    anchor?.dispose();
    anchor = sel && anchorSelection(terminal, sel);
    scrollAnchor?.marker.dispose();
    scrollAnchor = null;
    const buffer = terminal.buffer.active;
    if (sel && !sel.dragging && buffer.type === 'normal') {
      const row = Math.min(sel.startRow, sel.endRow);
      scrollAnchor = { marker: terminal.registerMarker(row - (buffer.baseY + buffer.cursorY)), row };
    }
  });
  return {
    onRender() {
      if (!selection || baseline === null) return;
      if (scrollAnchor?.marker.isDisposed) { setSelection(id, null); return; }
      const shift = scrollAnchor ? scrollAnchor.marker.line - scrollAnchor.row : 0;
      const moved = shift ? { ...selection, startRow: selection.startRow + shift, endRow: selection.endRow + shift } : selection;
      if (extractSelectionText(terminal, moved) !== baseline) setSelection(id, null);
      else if (moved !== selection) followCopySelection(id, terminal, spanOfSelection(moved));
    },
    onResize() {
      const span = anchor && followReflow(terminal, anchor);
      if (span) followCopySelection(id, terminal, span);
      else setSelection(id, null);
    },
    dispose() {
      unsubscribe();
      anchor?.dispose();
      scrollAnchor?.marker.dispose();
    },
  };
}
