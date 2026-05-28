import { useContext, useLayoutEffect, useState, useEffect, useSyncExternalStore, type CSSProperties } from 'react';
import {
  DEFAULT_MOUSE_SELECTION_STATE,
  flashCopy,
  getMouseSelectionSnapshot,
  getRenderTick,
  setSelection,
  subscribeToMouseSelection,
  subscribeToRenderTick,
} from '../lib/mouse-selection';
import { copyRaw, copyRewrapped } from '../lib/clipboard';
import { CheckIcon } from '@phosphor-icons/react';
import { IS_MAC } from '../lib/platform';
import { getTerminalOverlayDims } from '../lib/terminal-registry';
import { PopupButtonRow, popupButton, Shortcut } from './design';
import { TouchUiContext } from './touch-ui-context';

interface Props {
  terminalId: string;
}

/**
 * Popup shown after a selection is finalized (mouse-up). Offers Copy Raw
 * and Copy Rewrapped. Dismissed on Esc, click-outside, or a successful copy.
 */
export function SelectionPopup({ terminalId }: Props) {
  const touchUi = useContext(TouchUiContext);
  const states = useSyncExternalStore(subscribeToMouseSelection, getMouseSelectionSnapshot);
  useSyncExternalStore(subscribeToRenderTick, getRenderTick);

  const state = states.get(terminalId) ?? DEFAULT_MOUSE_SELECTION_STATE;
  const selection = state.selection;
  const shouldRender = (!!selection && !selection.dragging) || !!state.copyFlash;

  const [anchor, setAnchor] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  useLayoutEffect(() => {
    if (!shouldRender || !selection) {
      setAnchor(null);
      return;
    }
    const dims = getTerminalOverlayDims(terminalId);
    if (!dims || dims.cols === 0 || dims.rows === 0) return;
    // Use the measured cell grid so the anchor aligns with the border
    // outline (the overlay pulls from the same dims).
    const { cellWidth, cellHeight, gridLeft, gridTop } = dims;
    const endViewportRow = selection.endRow - dims.viewportY;
    const endRow = Math.max(0, Math.min(dims.rows - 1, endViewportRow));
    // Place the popup on the side opposite the drag direction, matching
    // exactly where the Alt hint sat. Drag-down anchors by `top`, drag-up
    // anchors by `bottom` — that way both elements have their near-
    // selection edge at the same y regardless of their heights. Without
    // this, the popup (shorter than the hint) would appear closer to the
    // selection than the hint did on drag-up.
    const draggedDown = selection.endRow >= selection.startRow;
    const left = Math.min(dims.elementWidth - 300, Math.max(0, gridLeft + selection.endCol * cellWidth));
    if (touchUi) {
      // Mobile: always sit above the selection so the dragging thumb (which ends
      // at the selection's lower edge) never covers the copy buttons.
      const topRow = Math.max(0, Math.min(dims.rows - 1, Math.min(selection.startRow, selection.endRow) - dims.viewportY));
      const y = Math.max(gridTop + (topRow - 1) * cellHeight - 4, 28);
      setAnchor({ left, bottom: dims.elementHeight - y });
    } else if (draggedDown) {
      const top = Math.min(
        gridTop + (endRow + 2) * cellHeight + 4,
        dims.elementHeight - 24,
      );
      setAnchor({ left, top });
    } else {
      // Bottom-anchored one full cell above the selection — symmetric with
      // the drag-down +2-row offset on the top-anchored side.
      const y = Math.max(gridTop + (endRow - 1) * cellHeight - 4, 28);
      setAnchor({ left, bottom: dims.elementHeight - y });
    }
  }, [terminalId, shouldRender, selection, touchUi]);

  useEffect(() => {
    if (!shouldRender) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        setSelection(terminalId, null);
      }
    };
    const onMouseDown = (ev: MouseEvent) => {
      // Click anywhere outside the popup → dismiss. The overlay itself and
      // the terminal body both qualify. A new mousedown inside the terminal
      // will also begin a new drag (handled in terminal-registry), which
      // also replaces the selection.
      const target = ev.target as HTMLElement | null;
      if (!target?.closest(`[data-selection-popup-for="${terminalId}"]`)) {
        setSelection(terminalId, null);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('mousedown', onMouseDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('mousedown', onMouseDown, true);
    };
  }, [shouldRender, terminalId]);

  if (!shouldRender || !anchor) return null;

  const copyShortcut = IS_MAC ? 'Cmd+C' : 'Ctrl+C';
  const rewrapShortcut = IS_MAC ? 'Cmd+Shift+C' : 'Ctrl+Shift+C';

  const style: CSSProperties = {
    position: 'absolute',
    left: anchor.left,
    top: anchor.top,
    bottom: anchor.bottom,
    zIndex: 20,
  };

  const onCopy = async (rewrapped: boolean) => {
    if (rewrapped) {
      await copyRewrapped(terminalId);
    } else {
      await copyRaw(terminalId);
    }
    flashCopy(terminalId, rewrapped ? 'rewrapped' : 'raw');
  };

  const flashed = (kind: 'raw' | 'rewrapped') => state.copyFlash === kind;
  const buttonClass = (kind: 'raw' | 'rewrapped') => popupButton({ flashed: flashed(kind) });

  // The touch UI has no keyboard, so drop the shortcut hint there and keep only the
  // copy-success check. On desktop the check sits over the (hidden) shortcut so the
  // button width stays put while it flashes.
  const leadingIndicator = (kind: 'raw' | 'rewrapped', shortcut: string) => {
    if (touchUi) {
      return flashed(kind) ? (
        <span className="mr-1 inline-flex items-center align-middle">
          <CheckIcon size={12} weight="bold" />
        </span>
      ) : null;
    }
    return (
      <>
        <span className="relative inline-block">
          <Shortcut className={flashed(kind) ? 'invisible' : undefined}>{shortcut}</Shortcut>
          {flashed(kind) && (
            <span className="absolute inset-0 flex items-center justify-center">
              <CheckIcon size={12} weight="bold" />
            </span>
          )}
        </span>{' '}
      </>
    );
  };

  return (
    <PopupButtonRow
      data-selection-popup-for={terminalId}
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={buttonClass('raw')}
        onClick={() => onCopy(false)}
      >
        {leadingIndicator('raw', copyShortcut)}
        Copy Raw
      </button>
      <button
        type="button"
        className={buttonClass('rewrapped')}
        onClick={() => onCopy(true)}
      >
        {leadingIndicator('rewrapped', rewrapShortcut)}
        Copy Rewrapped
      </button>
    </PopupButtonRow>
  );
}
