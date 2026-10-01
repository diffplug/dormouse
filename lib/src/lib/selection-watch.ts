import type { Terminal } from '@xterm/xterm';
import { followCopySelection } from './copy-editor';
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
  const unsubscribe = subscribeToMouseSelection(() => {
    const sel = getMouseSelectionState(id).selection;
    if (sel === selection) return;
    selection = sel;
    baseline = sel && !sel.dragging ? extractSelectionText(terminal, sel) : null;
    anchor?.dispose();
    anchor = sel && anchorSelection(terminal, sel);
  });
  return {
    onRender() {
      if (selection && baseline !== null && extractSelectionText(terminal, selection) !== baseline) setSelection(id, null);
    },
    onResize() {
      const span = anchor && followReflow(terminal, anchor);
      if (span) followCopySelection(id, terminal, span);
      else setSelection(id, null);
    },
    dispose() {
      unsubscribe();
      anchor?.dispose();
    },
  };
}
