import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { PlusIcon } from '@phosphor-icons/react';
import { clsx } from 'clsx';
import { ModalCloseButton, POPUP_SURFACE_CLASS, popupButton } from './design';
import { NoteList } from './NoteList';
import { usePopoverFocusTrap } from './use-popover-focus-trap';
import { copyNote, useNotes, useOpenNotepadId } from './use-notepad';
import { hasNotepadArchive } from '../lib/notepad/archive-service';
import { DialogKeyboardContext } from './wall/wall-context';
import {
  addPlainNote,
  deleteNote,
  getNotes,
  pruneEmptyNote,
  setNoteText,
  setOpenNotepadId,
} from '../lib/notepad/notepad-store';
import { revealNoteSource } from '../lib/notepad/pin';
import type { LiveNote } from '../lib/notepad/types';

/**
 * The attached notepad: a panel in the top-right corner of a Surface's body,
 * three quarters of it wide and tall (docs/specs/notepad.md → Notepad UI).
 *
 * Mounted by every Surface body but rendered only for the one open notepad —
 * the store keeps a single `openNotepadId`, so a Wall never shows two. It stays
 * mounted while closed so a failed pin can reopen it with its message.
 */
export function NotepadPanel({ surfaceId }: { surfaceId: string }) {
  const openId = useOpenNotepadId();
  const [sourceUnavailableNoteId, setSourceUnavailableNoteId] = useState<string | null>(null);
  const open = openId === surfaceId;

  // A pin closes the panel, follows the source, and on failure reopens it
  // saying so. Both stores settle inside this one handler, so the panel below
  // never unmounts in between and the message survives.
  const revealSource = useCallback((noteId: string) => {
    setOpenNotepadId(null);
    const outcome = revealNoteSource(surfaceId, noteId);
    if (outcome.ok) {
      setSourceUnavailableNoteId(null);
      return;
    }
    setSourceUnavailableNoteId(noteId);
    setOpenNotepadId(surfaceId);
  }, [surfaceId]);

  // A message belongs to the panel that reported it; the next open starts clean.
  useEffect(() => {
    if (!open) setSourceUnavailableNoteId(null);
  }, [open]);

  if (!hasNotepadArchive() || !open) return null;
  return (
    <OpenNotepadPanel
      surfaceId={surfaceId}
      sourceUnavailableNoteId={sourceUnavailableNoteId}
      onRevealSource={revealSource}
    />
  );
}

function OpenNotepadPanel({
  surfaceId,
  sourceUnavailableNoteId,
  onRevealSource,
}: {
  surfaceId: string;
  sourceUnavailableNoteId: string | null;
  onRevealSource: (noteId: string) => void;
}) {
  const notes = useNotes(surfaceId);
  const setDialogKeyboardActive = useContext(DialogKeyboardContext);
  const panelRef = useRef<HTMLDivElement>(null);
  const [addedNoteId, setAddedNoteId] = useState<string | null>(null);

  const close = useCallback(() => setOpenNotepadId(null), []);

  // Escape, Tab cycling, and outside-click dismissal, the same contract every
  // other pane popover uses.
  usePopoverFocusTrap(panelRef, close);

  // The panel owns the keyboard while open, so command-mode keys stay dormant
  // under a note being typed into.
  useEffect(() => {
    setDialogKeyboardActive(true);
    return () => setDialogKeyboardActive(false);
  }, [setDialogKeyboardActive]);

  // Focus the panel itself (not a note) so Escape reaches the focus trap even
  // when the header button opened it.
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

  // An Add New that was never typed into disappears with the panel, exactly as
  // it does on blur.
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
      ref={panelRef}
      // A dialog by role as well as by behavior: the browser surface's
      // key-forwarder stands down for `[role="dialog"]` targets, so typing a
      // note over a live browser never reaches the page.
      role="dialog"
      aria-label="Notepad"
      tabIndex={-1}
      data-notepad-panel-for={surfaceId}
      className={`${POPUP_SURFACE_CLASS} absolute right-1 top-1 flex h-3/4 w-3/4 flex-col overflow-hidden text-sm focus:outline-none`}
      // Clicks and keys inside the panel are the panel's alone: neither the
      // pane's focus-on-click nor a surface's own key handling may see them.
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
        <ModalCloseButton aria-label="Close notepad" onClick={close} />
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
