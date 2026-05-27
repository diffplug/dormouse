import type { Terminal } from '@xterm/xterm';
import {
  beginDrag,
  endDrag,
  getMouseSelectionState,
  isDragging,
  setDragAlt,
  setHintToken,
  setOverride,
  setSelection,
  stateRequiresNativeMouseSuppression,
  updateDrag,
} from './mouse-selection';
import { detectTokenAt } from './smart-token';
import { extractSelectionText } from './selection-text';
import type { TerminalOverlayDims } from './terminal-store';

const OVERRIDE_MOUSE_EVENTS = ['mousemove', 'mouseup', 'wheel', 'click', 'dblclick', 'auxclick', 'contextmenu'] as const;

function consumePointerEvent(ev: MouseEvent | PointerEvent, stopImmediate = false): void {
  ev.preventDefault();
  ev.stopPropagation();
  if (stopImmediate) ev.stopImmediatePropagation();
}

function isNonMousePointerEvent(ev: MouseEvent | PointerEvent): ev is PointerEvent {
  return 'pointerType' in ev && ev.pointerType !== 'mouse';
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
  const computeCell = (ev: MouseEvent | PointerEvent): { row: number; col: number; startedInScrollback: boolean } => {
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
    pointerId: number | null;
    touchLike: boolean;
  } | null = null;
  let activePointerId: number | null = null;
  let suppressSyntheticMouseUntil = 0;

  const terminalOwnsEvent = (ev: MouseEvent | PointerEvent) => {
    const state = getMouseSelectionState(id);
    const cell = computeCell(ev);
    const terminalOwns =
      state.mouseReporting === 'none'
      || state.override !== 'off'
      || cell.startedInScrollback;
    return { state, cell, terminalOwns };
  };

  const beginPendingDrag = (
    ev: MouseEvent | PointerEvent,
    opts: { pointerId: number | null; touchLike: boolean },
  ) => {
    const { state, cell, terminalOwns } = terminalOwnsEvent(ev);
    if (!terminalOwns) return false;
    const suppressNativeMouse = state.mouseReporting !== 'none';
    if (suppressNativeMouse || opts.touchLike) {
      consumePointerEvent(ev, true);
      terminal.focus();
    }
    if (ev.button !== 0 && !suppressNativeMouse) return true;
    pendingDrag = {
      row: cell.row,
      col: cell.col,
      altKey: ev.altKey,
      startedInScrollback: cell.startedInScrollback,
      button: ev.button,
      clientX: ev.clientX,
      clientY: ev.clientY,
      pointerId: opts.pointerId,
      touchLike: opts.touchLike,
    };
    return true;
  };

  const updatePendingOrActiveDrag = (ev: MouseEvent | PointerEvent) => {
    let consumed = false;
    if (pendingDrag) {
      const suppressNativeMouse = stateRequiresNativeMouseSuppression(getMouseSelectionState(id));
      if (suppressNativeMouse || pendingDrag.touchLike) {
        consumePointerEvent(ev, true);
        consumed = true;
      }
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
    const suppressNativeMouse = stateRequiresNativeMouseSuppression(getMouseSelectionState(id));
    if (!consumed) consumePointerEvent(ev, suppressNativeMouse || isNonMousePointerEvent(ev));

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

  const finishPendingOrActiveDrag = (ev: MouseEvent | PointerEvent) => {
    if (pendingDrag) {
      if (ev.button !== pendingDrag.button) return;
      const suppressNativeMouse = stateRequiresNativeMouseSuppression(getMouseSelectionState(id));
      if (suppressNativeMouse || pendingDrag.touchLike) consumePointerEvent(ev, true);
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
    consumePointerEvent(ev, suppressNativeMouse || isNonMousePointerEvent(ev));
  };

  const onMouseDown = (ev: MouseEvent) => {
    if (Date.now() < suppressSyntheticMouseUntil) {
      consumePointerEvent(ev, true);
      return;
    }
    beginPendingDrag(ev, { pointerId: null, touchLike: false });
  };

  const onPointerDown = (ev: PointerEvent) => {
    if (ev.pointerType === 'mouse') return;
    if (!ev.isPrimary) return;
    const handled = beginPendingDrag(ev, { pointerId: ev.pointerId, touchLike: true });
    if (!handled) return;
    activePointerId = ev.pointerId;
    suppressSyntheticMouseUntil = Date.now() + 800;
    try {
      element.setPointerCapture(ev.pointerId);
    } catch {
      // Pointer capture is a best-effort continuity aid; window listeners still
      // keep the drag alive in browsers that reject capture here.
    }
  };

  const onOverrideMouseEvent = (ev: MouseEvent) => {
    if (Date.now() < suppressSyntheticMouseUntil) {
      consumePointerEvent(ev, true);
      return;
    }
    const state = getMouseSelectionState(id);
    if (state.mouseReporting === 'none' || state.override === 'off') return;
    consumePointerEvent(ev, true);
  };

  const onWindowMouseMove = (ev: MouseEvent) => {
    updatePendingOrActiveDrag(ev);
  };

  const onWindowMouseUp = (ev: MouseEvent) => {
    finishPendingOrActiveDrag(ev);
  };

  const onWindowPointerMove = (ev: PointerEvent) => {
    if (ev.pointerType === 'mouse') return;
    if (activePointerId !== ev.pointerId) return;
    updatePendingOrActiveDrag(ev);
  };

  const onWindowPointerUp = (ev: PointerEvent) => {
    if (ev.pointerType === 'mouse') return;
    if (activePointerId !== ev.pointerId) return;
    finishPendingOrActiveDrag(ev);
    activePointerId = null;
    try {
      element.releasePointerCapture(ev.pointerId);
    } catch {
      // See setPointerCapture comment above.
    }
  };

  const onWindowPointerCancel = (ev: PointerEvent) => {
    if (ev.pointerType === 'mouse') return;
    if (activePointerId !== ev.pointerId) return;
    pendingDrag = null;
    activePointerId = null;
    setSelection(id, null);
    setHintToken(id, null);
    consumePointerEvent(ev, true);
    try {
      element.releasePointerCapture(ev.pointerId);
    } catch {
      // See setPointerCapture comment above.
    }
  };

  const onAltChange = (ev: KeyboardEvent) => {
    if (!isDragging(id)) return;
    setDragAlt(id, ev.altKey);
  };

  element.addEventListener('mousedown', onMouseDown, true);
  element.addEventListener('pointerdown', onPointerDown, true);
  for (const type of OVERRIDE_MOUSE_EVENTS) {
    element.addEventListener(type, onOverrideMouseEvent, true);
  }
  window.addEventListener('mousemove', onWindowMouseMove, true);
  window.addEventListener('mouseup', onWindowMouseUp, true);
  window.addEventListener('pointermove', onWindowPointerMove, true);
  window.addEventListener('pointerup', onWindowPointerUp, true);
  window.addEventListener('pointercancel', onWindowPointerCancel, true);
  window.addEventListener('keydown', onAltChange, true);
  window.addEventListener('keyup', onAltChange, true);

  return () => {
    element.removeEventListener('mousedown', onMouseDown, true);
    element.removeEventListener('pointerdown', onPointerDown, true);
    for (const type of OVERRIDE_MOUSE_EVENTS) {
      element.removeEventListener(type, onOverrideMouseEvent, true);
    }
    window.removeEventListener('mousemove', onWindowMouseMove, true);
    window.removeEventListener('mouseup', onWindowMouseUp, true);
    window.removeEventListener('pointermove', onWindowPointerMove, true);
    window.removeEventListener('pointerup', onWindowPointerUp, true);
    window.removeEventListener('pointercancel', onWindowPointerCancel, true);
    window.removeEventListener('keydown', onAltChange, true);
    window.removeEventListener('keyup', onAltChange, true);
  };
}
