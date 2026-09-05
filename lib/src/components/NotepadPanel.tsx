import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { NotepadBody } from './NotepadBody';
import { useOpenNotepadId } from './use-notepad';
import { hasNotepadArchive } from '../lib/notepad/archive-service';
import { DialogKeyboardContext } from './wall/wall-context';
import { setOpenNotepadId } from '../lib/notepad/notepad-store';
import { revealNoteSource } from '../lib/notepad/pin';

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
  const setDialogKeyboardActive = useContext(DialogKeyboardContext);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpenNotepadId(null), []);

  // The panel owns the keyboard while open, so command-mode keys stay dormant
  // under a note being typed into.
  useEffect(() => {
    setDialogKeyboardActive(true);
    return () => setDialogKeyboardActive(false);
  }, [setDialogKeyboardActive]);

  return (
    <NotepadBody
      surfaceId={surfaceId}
      containerRef={panelRef}
      className="absolute right-1 top-1 h-3/4 w-3/4"
      dataAttributes={{ 'data-notepad-panel-for': surfaceId }}
      sourceUnavailableNoteId={sourceUnavailableNoteId}
      onClose={close}
      onRevealSource={onRevealSource}
    />
  );
}
