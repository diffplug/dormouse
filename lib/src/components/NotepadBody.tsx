import { useCallback, useEffect, useState, type CSSProperties, type RefObject } from 'react';
import { PlusIcon } from '@phosphor-icons/react';
import { clsx } from 'clsx';
import { ModalCloseButton, POPUP_SURFACE_CLASS, popupButton } from './design';
import { NoteList } from './NoteList';
import { usePopoverFocusTrap } from './use-popover-focus-trap';
import { copyNote, useNotes } from './use-notepad';
import {
  addPlainNote,
  deleteNote,
  getNotes,
  pruneEmptyNote,
  setNoteText,
} from '../lib/notepad/notepad-store';
import type { LiveNote } from '../lib/notepad/types';

/**
 * One Surface's notepad: the dialog element, its header, and the editable list
 * (docs/specs/notepad.md → "Notepad UI").
 *
 * Both notepads are this component — `NotepadPanel` positions it inside a
 * Surface body, `DoorNotepadPopover` portals it above a Door — so Add New and
 * its focus, the blur/close prune, the keyboard ownership and the pin row have
 * one implementation rather than two that must be kept identical. What differs
 * is placement, which the caller supplies as `className` / `style` and reads
 * back through `containerRef`.
 */
export function NotepadBody({
  surfaceId,
  containerRef,
  className,
  style,
  dataAttributes,
  sourceUnavailableNoteId,
  onClose,
  onRevealSource,
}: {
  surfaceId: string;
  /** The dialog element, so a caller can measure it (the Door popover clamps
   *  itself against the Wall once it knows its own size). */
  containerRef: RefObject<HTMLDivElement | null>;
  className?: string;
  style?: CSSProperties;
  /** Which notepad this is, for tests and stories. */
  dataAttributes?: Record<string, string>;
  sourceUnavailableNoteId: string | null;
  onClose: () => void;
  onRevealSource: (noteId: string) => void;
}) {
  const notes = useNotes(surfaceId);
  const [addedNoteId, setAddedNoteId] = useState<string | null>(null);

  // Escape, Tab cycling, and outside-click dismissal, the same contract every
  // other pane popover uses.
  usePopoverFocusTrap(containerRef, onClose);

  // Focus the dialog itself (not a note) so Escape reaches the focus trap even
  // when a header button opened it.
  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true });
  }, [containerRef]);

  // An Add New that was never typed into disappears with the notepad, exactly
  // as it does on blur.
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

  return (
    <div
      ref={containerRef}
      // A dialog by role as well as by behavior: the browser surface's
      // key-forwarder stands down for `[role="dialog"]` targets, so typing a
      // note over a live browser never reaches the page.
      role="dialog"
      aria-label="Notepad"
      tabIndex={-1}
      {...dataAttributes}
      className={clsx(POPUP_SURFACE_CLASS, 'flex flex-col overflow-hidden text-sm focus:outline-none', className)}
      style={style}
      // Clicks and keys inside are the notepad's alone: neither the pane's
      // focus-on-click nor a surface's own key handling may see them.
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
    </div>
  );
}
