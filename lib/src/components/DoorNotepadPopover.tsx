import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { PlusIcon } from '@phosphor-icons/react';
import { clsx } from 'clsx';
import { ModalCloseButton, POPUP_SURFACE_CLASS, popupButton } from './design';
import { NoteList } from './NoteList';
import { usePopoverFocusTrap } from './use-popover-focus-trap';
import { copyNote, useNotes } from './use-notepad';
import { clampOverlayPosition } from '../lib/ui-geometry';
import {
  addPlainNote,
  deleteNote,
  getNotes,
  pruneEmptyNote,
  setNoteText,
} from '../lib/notepad/notepad-store';
import type { LiveNote } from '../lib/notepad/types';

/** Gap between the Door's top edge and the popover above it. */
const DOOR_POPOVER_GAP_PX = 4;

/**
 * A minimized Surface's notepad, above its Door (docs/specs/notepad.md →
 * Notepad UI). Same list and same editing as the attached panel; what differs
 * is that opening it never reattaches the Surface, and that a pin does — the
 * Baseboard owns that sequence and passes it in as `onRevealSource`.
 */
export function DoorNotepadPopover({
  surfaceId,
  anchorRect,
  sourceUnavailableNoteId,
  onClose,
  onRevealSource,
  onKeyboardActiveChange,
}: {
  surfaceId: string;
  /** The Door's rect. Measured at open; the popover keeps its place if the
   *  Door goes away under it (a pin reattaches the Surface). */
  anchorRect: DOMRect;
  sourceUnavailableNoteId: string | null;
  onClose: () => void;
  onRevealSource: (noteId: string) => void;
  onKeyboardActiveChange: (active: boolean) => void;
}) {
  const notes = useNotes(surfaceId);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [addedNoteId, setAddedNoteId] = useState<string | null>(null);
  const [style, setStyle] = useState<CSSProperties>({
    position: 'fixed',
    left: anchorRect.left,
    top: anchorRect.top,
  });

  // Width is content-driven up to the cap, so placement has to measure first;
  // re-run when the list changes height under it.
  useLayoutEffect(() => {
    const el = popoverRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setStyle(clampOverlayPosition({
      left: anchorRect.left,
      top: anchorRect.top - rect.height - DOOR_POPOVER_GAP_PX,
      width: rect.width,
      height: rect.height,
    }));
  }, [anchorRect, notes, sourceUnavailableNoteId]);

  usePopoverFocusTrap(popoverRef, onClose);

  useEffect(() => {
    onKeyboardActiveChange(true);
    return () => onKeyboardActiveChange(false);
  }, [onKeyboardActiveChange]);

  useEffect(() => {
    popoverRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => () => {
    for (const note of getNotes(surfaceId)) pruneEmptyNote(surfaceId, note.id);
  }, [surfaceId]);

  const addNote = useCallback(() => {
    setAddedNoteId(addPlainNote(surfaceId));
  }, [surfaceId]);

  const editNote = useCallback((noteId: string, text: string) => {
    setNoteText(surfaceId, noteId, text);
  }, [surfaceId]);

  const removeNote = useCallback((note: LiveNote) => {
    deleteNote(surfaceId, note.id);
  }, [surfaceId]);

  const pruneNote = useCallback((noteId: string) => {
    pruneEmptyNote(surfaceId, noteId);
  }, [surfaceId]);

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Notepad"
      tabIndex={-1}
      data-notepad-popover-for={surfaceId}
      className={`${POPUP_SURFACE_CLASS} flex max-h-[75dvh] w-fit max-w-[30rem] flex-col overflow-hidden text-sm focus:outline-none`}
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <span className="min-w-0 flex-1 truncate font-medium">Notepad</span>
        <button
          type="button"
          className={clsx(popupButton(), 'flex items-center gap-1 rounded')}
          aria-label="Add new note"
          onClick={addNote}
        >
          <PlusIcon size={12} weight="bold" />
          Add New
        </button>
        <ModalCloseButton aria-label="Close notepad" onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {notes.length === 0 ? (
          <p className="px-2 py-2 text-muted">No notes yet.</p>
        ) : (
          <NoteList
            notes={notes}
            onCopy={copyNote}
            onDelete={removeNote}
            onEdit={editNote}
            onRevealSource={onRevealSource}
            sourceUnavailableNoteId={sourceUnavailableNoteId}
            autoFocusNoteId={addedNoteId}
            onNoteBlur={pruneNote}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
