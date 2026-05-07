import type { Terminal } from '@xterm/xterm';
import {
  beginDrag,
  endDrag,
  getMouseSelectionState,
  isDragging,
  setDragAlt,
  setHintToken,
  setOverride,
  stateRequiresNativeMouseSuppression,
  updateDrag,
} from './mouse-selection';
import { detectTokenAt } from './smart-token';
import { extractSelectionText } from './selection-text';
import type { TerminalOverlayDims } from './terminal-store';

const OVERRIDE_MOUSE_EVENTS = ['mousemove', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'] as const;

function consumeMouseEvent(ev: MouseEvent, stopImmediate = false): void {
  ev.preventDefault();
  ev.stopPropagation();
  if (stopImmediate) ev.stopImmediatePropagation();
}

// Defer the override clear so any same-tick listener that re-reads the state
// (e.g. xterm's own mouseup handler) still sees `temporary` and can emit its
// trailing report before we flip back to `off`.
function clearTemporaryOverrideAfterMouseDispatch(id: string): void {
  if (getMouseSelectionState(id).override !== 'temporary') return;
  queueMicrotask(() => {
    if (getMouseSelectionState(id).override === 'temporary') {
      setOverride(id, 'off');
    }
  });
}

export function attachTerminalMouseRouter({
  id,
  terminal,
  element,
  getOverlayDims,
  setSelectionBaseline,
}: {
  id: string;
  terminal: Terminal;
  element: HTMLDivElement;
  getOverlayDims: (id: string) => TerminalOverlayDims | null;
  setSelectionBaseline: (baseline: string | null) => void;
}): () => void {
  const computeCell = (ev: MouseEvent): { row: number; col: number; startedInScrollback: boolean } => {
    const dims = getOverlayDims(id);
    if (!dims) {
      return { row: 0, col: 0, startedInScrollback: false };
    }
    const elementRect = element.getBoundingClientRect();
    const offsetX = ev.clientX - elementRect.left - dims.gridLeft;
    const offsetY = ev.clientY - elementRect.top - dims.gridTop;
    const col = Math.min(dims.cols - 1, Math.max(0, Math.floor(offsetX / dims.cellWidth)));
    const viewportRow = Math.min(dims.rows - 1, Math.max(0, Math.floor(offsetY / dims.cellHeight)));
    const absRow = dims.viewportY + viewportRow;
    const startedInScrollback = absRow < dims.baseY;
    return { row: absRow, col, startedInScrollback };
  };

  const DRAG_THRESHOLD_PX_SQ = 16;
  let pendingDrag: {
    row: number;
    col: number;
    altKey: boolean;
    startedInScrollback: boolean;
    button: number;
    clientX: number;
    clientY: number;
  } | null = null;

  const onMouseDown = (ev: MouseEvent) => {
    const state = getMouseSelectionState(id);
    const cell = computeCell(ev);
    const terminalOwns =
      state.mouseReporting === 'none'
      || state.override !== 'off'
      || cell.startedInScrollback;
    if (!terminalOwns) return;
    const suppressNativeMouse = state.mouseReporting !== 'none';
    if (suppressNativeMouse) {
      consumeMouseEvent(ev, true);
      terminal.focus();
    }
    if (ev.button !== 0 && !suppressNativeMouse) return;
    pendingDrag = {
      row: cell.row,
      col: cell.col,
      altKey: ev.altKey,
      startedInScrollback: cell.startedInScrollback,
      button: ev.button,
      clientX: ev.clientX,
      clientY: ev.clientY,
    };
  };

  const onOverrideMouseEvent = (ev: MouseEvent) => {
    const state = getMouseSelectionState(id);
    if (state.mouseReporting === 'none' || state.override === 'off') return;
    consumeMouseEvent(ev, true);
  };

  const onWindowMouseMove = (ev: MouseEvent) => {
    if (pendingDrag) {
      if (stateRequiresNativeMouseSuppression(getMouseSelectionState(id))) consumeMouseEvent(ev, true);
      if (pendingDrag.button !== 0) return;
      const dx = ev.clientX - pendingDrag.clientX;
      const dy = ev.clientY - pendingDrag.clientY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX_SQ) return;
      beginDrag(id, {
        row: pendingDrag.row,
        col: pendingDrag.col,
        altKey: pendingDrag.altKey,
        startedInScrollback: pendingDrag.startedInScrollback,
      });
      terminal.clearSelection();
      pendingDrag = null;
    }
    if (!isDragging(id)) return;
    const cell = computeCell(ev);
    updateDrag(id, { row: cell.row, col: cell.col, altKey: ev.altKey });
    consumeMouseEvent(ev, stateRequiresNativeMouseSuppression(getMouseSelectionState(id)));

    const line = terminal.buffer.active.getLine(cell.row);
    const text = line?.translateToString(false, 0, terminal.cols);
    const token = text ? detectTokenAt(text, cell.col) : null;
    setHintToken(id, token ? {
      kind: token.kind,
      row: cell.row,
      startCol: token.start,
      endCol: token.end,
      text: token.text,
    } : null);
  };

  const onWindowMouseUp = (ev: MouseEvent) => {
    if (pendingDrag) {
      if (ev.button !== pendingDrag.button) return;
      if (stateRequiresNativeMouseSuppression(getMouseSelectionState(id))) consumeMouseEvent(ev, true);
      clearTemporaryOverrideAfterMouseDispatch(id);
      pendingDrag = null;
      return;
    }
    if (ev.button !== 0) return;
    if (!isDragging(id)) return;
    const suppressNativeMouse = stateRequiresNativeMouseSuppression(getMouseSelectionState(id));
    endDrag(id);
    setHintToken(id, null);
    const sel = getMouseSelectionState(id).selection;
    setSelectionBaseline(sel ? extractSelectionText(terminal, sel) : null);
    clearTemporaryOverrideAfterMouseDispatch(id);
    consumeMouseEvent(ev, suppressNativeMouse);
  };

  const onAltChange = (ev: KeyboardEvent) => {
    if (!isDragging(id)) return;
    setDragAlt(id, ev.altKey);
  };

  element.addEventListener('mousedown', onMouseDown, true);
  for (const type of OVERRIDE_MOUSE_EVENTS) {
    element.addEventListener(type, onOverrideMouseEvent, true);
  }
  window.addEventListener('mousemove', onWindowMouseMove, true);
  window.addEventListener('mouseup', onWindowMouseUp, true);
  window.addEventListener('keydown', onAltChange, true);
  window.addEventListener('keyup', onAltChange, true);

  return () => {
    element.removeEventListener('mousedown', onMouseDown, true);
    for (const type of OVERRIDE_MOUSE_EVENTS) {
      element.removeEventListener(type, onOverrideMouseEvent, true);
    }
    window.removeEventListener('mousemove', onWindowMouseMove, true);
    window.removeEventListener('mouseup', onWindowMouseUp, true);
    window.removeEventListener('keydown', onAltChange, true);
    window.removeEventListener('keyup', onAltChange, true);
  };
}
