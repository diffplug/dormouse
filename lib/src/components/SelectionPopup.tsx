import { useContext, useLayoutEffect, useState, useEffect, useSyncExternalStore, type CSSProperties } from 'react';
import {
  DEFAULT_MOUSE_SELECTION_STATE,
  flashCopy,
  getMouseSelectionSnapshot,
  getRenderTick,
  setSelection,
  subscribeToMouseSelection,
  subscribeToRenderTick,
  type CopyFlashKind,
} from '../lib/mouse-selection';
import { copyRaw, copyRewrapped } from '../lib/clipboard';
import { CheckIcon } from '@phosphor-icons/react';
import { hasNotepadArchive } from '../lib/notepad/archive-service';
import { addSelectionToNotepad, isNotepadChordBound } from '../lib/notepad/capture';
import { IS_MAC } from '../lib/platform';
import { getTerminalOverlayDims } from '../lib/terminal-registry';
import { PopupButtonRow, popupButton, Shortcut } from './design';
import { TouchUiContext } from './touch-ui-context';

interface Props {
  terminalId: string;
}

// The left clamp has to know how wide the popup will be before it exists, and
// the row is three variable-length labels wide (or two, with no notepad). Mono
// `text-sm` is 12px with a ~0.6em advance; each button adds `px-1.5` either
// side and the row itself a 1px border either side.
const CHAR_PX = 7.2;
const BUTTON_PADDING_PX = 12;
const ROW_BORDER_PX = 2;

function estimatePopupWidth(labels: readonly string[]): number {
  return labels.reduce((sum, label) => sum + label.length * CHAR_PX + BUTTON_PADDING_PX, ROW_BORDER_PX);
}

/**
 * Popup shown after a selection is finalized (mouse-up). Offers Copy Raw,
 * Copy Rewrapped, and — where the host has a notepad — Add to notepad.
 * Dismissed on Esc, click-outside, or a successful copy or capture.
 */
export function SelectionPopup({ terminalId }: Props) {
  const touchUi = useContext(TouchUiContext);
  const states = useSyncExternalStore(subscribeToMouseSelection, getMouseSelectionSnapshot);
  useSyncExternalStore(subscribeToRenderTick, getRenderTick);

  const state = states.get(terminalId) ?? DEFAULT_MOUSE_SELECTION_STATE;
  const selection = state.selection;
  const shouldRender = (!!selection && !selection.dragging) || !!state.copyFlash;

  const [anchor, setAnchor] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  const showNotepad = hasNotepadArchive();
  // The touch UI has no keyboard, and the website demo's browser has already
  // claimed the chord, so both keep the button and drop the label.
  const showShortcuts = !touchUi;
  const copyShortcut = IS_MAC ? 'Cmd+C' : 'Ctrl+C';
  const rewrapShortcut = IS_MAC ? 'Cmd+Shift+C' : 'Ctrl+Shift+C';
  const notepadShortcut = isNotepadChordBound() ? (IS_MAC ? 'Cmd+N' : 'Ctrl+N') : null;

  const label = (text: string, shortcut: string | null) =>
    showShortcuts && shortcut ? `[${shortcut}] ${text}` : text;

  useLayoutEffect(() => {
    if (!shouldRender || !selection) {
      setAnchor(null);
      return;
    }
    const dims = getTerminalOverlayDims(terminalId);
    if (!dims || dims.cols === 0 || dims.rows === 0) return;
    // Estimated here rather than per render: this clamp is its only consumer,
    // and the popup re-renders on every xterm frame of every pane.
    const popupWidth = estimatePopupWidth([
      label('Copy Raw', copyShortcut),
      label('Copy Rewrapped', rewrapShortcut),
      ...(showNotepad ? [label('Add to notepad', notepadShortcut)] : []),
    ]);
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
    // Outer `max(0, …)`: in a pane too narrow to hold the whole row, pin it to
    // the left edge rather than pushing its first button off screen.
    const left = Math.max(
      0,
      Math.min(dims.elementWidth - popupWidth, gridLeft + selection.endCol * cellWidth),
    );
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `label` is rebuilt
    // every render; the shortcut strings and `showNotepad` it closes over are
    // the real inputs and are listed.
  }, [terminalId, shouldRender, selection, touchUi, showNotepad, showShortcuts, copyShortcut, rewrapShortcut, notepadShortcut]);

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
      // will also begin a new drag (terminal-mouse-router), which replaces
      // the selection anyway.
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

  // The flash is the whole confirmation: it clears the selection when it ends,
  // which dismisses the popup without ever showing the notepad.
  const onAddToNotepad = () => {
    if (addSelectionToNotepad(terminalId)) flashCopy(terminalId, 'notepad');
  };

  const flashed = (kind: CopyFlashKind) => state.copyFlash === kind;
  const buttonClass = (kind: CopyFlashKind) => popupButton({ flashed: flashed(kind) });

  // With a shortcut the check sits over the (hidden) label, so the button width
  // stays put while it flashes; with none there is nothing to hide behind and
  // the check simply appears.
  const leadingIndicator = (kind: CopyFlashKind, shortcut: string | null) => {
    if (!showShortcuts || !shortcut) {
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
      {showNotepad && (
        <button
          type="button"
          className={buttonClass('notepad')}
          onClick={onAddToNotepad}
        >
          {leadingIndicator('notepad', notepadShortcut)}
          Add to notepad
        </button>
      )}
    </PopupButtonRow>
  );
}
