import { useCallback, useRef, useState } from 'react';
import { NotepadBody } from './NotepadBody';
import { sourceNoticeFor, type SourceNotice } from './NoteList';
import { useOpenNotepadId } from './use-notepad';
import { hasNotepadArchive } from '../lib/notepad/archive-service';
import { useDialogKeyboardOwner } from './wall/wall-context';
import { setOpenNotepadId } from '../lib/notepad/notepad-store';
import { revealNoteSource } from '../lib/notepad/pin';

/**
 * The attached notepad: a panel in the top-right corner of a Surface's body,
 * three quarters of it wide and tall (docs/specs/notepad.md → Notepad UI).
 *
 * Mounted by every Surface body but rendered only for the one open notepad —
 * the store keeps a single `openNotepadId`, so a Wall never shows two.
 */
export function NotepadPanel({ surfaceId, pins = true }: { surfaceId: string; pins?: boolean }) {
  const open = useOpenNotepadId() === surfaceId;
  if (!hasNotepadArchive() || !open) return null;
  return <OpenNotepadPanel surfaceId={surfaceId} pins={pins} />;
}

/** Mounted only while open, so a source notice dies with the close that ends it. */
function OpenNotepadPanel({ surfaceId, pins }: { surfaceId: string; pins: boolean }) {
  const [sourceNotice, setSourceNotice] = useState<SourceNotice | null>(null);

  // A pin closes the panel, follows the source, and on failure reopens it
  // saying so. Both store writes settle inside this one handler, so this panel
  // never unmounts in between and the message survives.
  const revealSource = useCallback((noteId: string) => {
    setOpenNotepadId(null);
    const notice = sourceNoticeFor(noteId, revealNoteSource(surfaceId, noteId));
    setSourceNotice(notice);
    if (notice) setOpenNotepadId(surfaceId);
  }, [surfaceId]);

  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpenNotepadId(null), []);

  // The panel owns the keyboard while open, so command-mode keys stay dormant
  // under a note being typed into. Mounted only while open, so the lease is
  // unconditional and independent of any other dialog's.
  useDialogKeyboardOwner(true);

  return (
    <NotepadBody
      surfaceId={surfaceId}
      containerRef={panelRef}
      className="absolute right-1 top-1 h-3/4 w-3/4"
      dataAttributes={{ 'data-notepad-panel-for': surfaceId }}
      sourceNotice={sourceNotice}
      onClose={close}
      onRevealSource={pins ? revealSource : undefined}
    />
  );
}
