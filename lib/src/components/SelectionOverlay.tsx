import { useContext, useSyncExternalStore, type CSSProperties } from 'react';
import {
  DEFAULT_MOUSE_SELECTION_STATE,
  getMouseSelectionSnapshot,
  getRenderTick,
  subscribeToMouseSelection,
  subscribeToRenderTick,
} from '../lib/mouse-selection';
import { computeRects, rectsToPath } from '../lib/selection-geometry';
import { getTerminalOverlayDims } from '../lib/terminal-registry';
import { IS_MAC } from '../lib/platform';
import { useFocusRingColor } from '../lib/themes/use-focus-ring-color';
import { PopupButtonRow } from './design';
import { TouchUiContext } from './touch-ui-context';

interface Props {
  terminalId: string;
}

/**
 * Compositor-layer selection highlight rendered above xterm's cell grid.
 * Re-measures on every render tick (scroll, resize, output).
 */
export function SelectionOverlay({ terminalId }: Props) {
  const touchUi = useContext(TouchUiContext);
  const states = useSyncExternalStore(subscribeToMouseSelection, getMouseSelectionSnapshot);
  // Subscribe to render tick so we re-render whenever xterm scrolls or resizes.
  useSyncExternalStore(subscribeToRenderTick, getRenderTick);
  // Pulled outside render-tick reads: --color-focus-ring only changes on theme
  // switch, but onRender fires every output frame.
  const focusRingColor = useFocusRingColor();

  const state = states.get(terminalId) ?? DEFAULT_MOUSE_SELECTION_STATE;
  const selection = state.selection;
  if (!selection) return null;

  const dims = getTerminalOverlayDims(terminalId);
  if (!dims || dims.cols === 0 || dims.rows === 0) return null;

  // cellWidth / cellHeight come from measuring xterm's `.xterm-screen`, and
  // gridLeft / gridTop are its offset within the element. Using these
  // instead of elementWidth/cols keeps the highlight aligned even when xterm
  // adds a few pixels of padding around the cell grid.
  const { cellWidth, cellHeight, gridLeft, gridTop } = dims;
  const rects = computeRects(selection, dims.cols, dims.viewportY, dims.rows, cellWidth, cellHeight);

  const style: CSSProperties = {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
    zIndex: 10,
  };

  const borderColor = focusRingColor || 'rgb(100, 149, 237)';
  const pathD = rectsToPath(rects);

  // Mid-drag hint. Placed outside the selection on the side opposite the
  // drag direction: below when the user drags down, above when they drag up.
  // Drag-down anchors by `top` (top edge aligned with where we want the
  // near-selection edge); drag-up anchors by `bottom` so the near-selection
  // edge lines up regardless of element height — this keeps the hint and
  // the copy popup visually coincident, since the popup uses the same
  // anchoring rules. Shown only while the user is dragging (spec §3.3).
  let hint: { left: number; top?: number; bottom?: number } | null = null;
  if (selection.dragging) {
    const endViewportRow = selection.endRow - dims.viewportY;
    if (endViewportRow >= 0 && endViewportRow < dims.rows) {
      const draggedDown = selection.endRow >= selection.startRow;
      const left = Math.min(dims.elementWidth - 180, Math.max(4, gridLeft + selection.endCol * cellWidth));
      if (touchUi) {
        // Mobile: always sit above the selection so the dragging thumb doesn't cover it.
        const topViewportRow = Math.min(selection.startRow, selection.endRow) - dims.viewportY;
        const y = Math.max(gridTop + (topViewportRow - 1) * cellHeight - 4, 28);
        hint = { left, bottom: dims.elementHeight - y };
      } else if (draggedDown) {
        const top = Math.min(
          gridTop + (endViewportRow + 2) * cellHeight + 4,
          dims.elementHeight - 24,
        );
        hint = { left, top };
      } else {
        // Anchor the element's bottom edge one full cell above the
        // selection — symmetric with the drag-down +2-row offset — so the
        // row adjacent to the selection stays visible. Clamp the anchor y
        // so there's at least ~24px of room above it for the hint to
        // render inside the viewport.
        const y = Math.max(gridTop + (endViewportRow - 1) * cellHeight - 4, 28);
        hint = { left, bottom: dims.elementHeight - y };
      }
    }
  }

  return (
    <div style={style} aria-hidden="true">
      {pathD && (
        <svg
          width={dims.elementWidth}
          height={dims.elementHeight}
          style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible' }}
        >
          <g transform={`translate(${gridLeft} ${gridTop})`}>
            <path
              d={pathD}
              fill="none"
              stroke={borderColor}
              strokeWidth={1.5}
              strokeLinejoin="miter"
            />
          </g>
        </svg>
      )}
      {hint && (
        <PopupButtonRow
          className="pointer-events-none absolute px-1.5 py-0.5"
          style={{ left: hint.left, top: hint.top, bottom: hint.bottom }}
        >
          <div className="flex flex-col gap-0.5 leading-none text-muted">
            <div>
              {touchUi
                ? 'Start drag with double-tap for block selection'
                : `Hold ${IS_MAC ? 'Opt' : 'Alt'} for block selection`}
            </div>
            {state.hintToken && (
              <div>
                Press <span className="text-foreground">e</span> to select the full{' '}
                {state.hintToken.kind === 'url' ? 'URL' : 'path'}
              </div>
            )}
          </div>
        </PopupButtonRow>
      )}
    </div>
  );
}

