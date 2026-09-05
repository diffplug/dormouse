import { useCallback, useEffect, useRef, useState } from 'react';
import { NotepadBody } from './NotepadBody';
import type { SourceNotice } from './NoteList';
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
 * the store keeps a single `openNotepadId`, so a Wall never shows two. It stays
 * mounted while closed so a failed pin can reopen it with its message.
 */
export function NotepadPanel({ surfaceId }: { surfaceId: string }) {
  const openId = useOpenNotepadId();
  const [sourceNotice, setSourceNotice] = useState<SourceNotice | null>(null);
  const open = openId === surfaceId;

  // A pin closes the panel, follows the source, and on failure reopens it
  // saying so. Both stores settle inside this one handler, so the panel below
  // never unmounts in between and the message survives.
  const revealSource = useCallback((noteId: string) => {
    setOpenNotepadId(null);
    const outcome = revealNoteSource(surfaceId, noteId);
    if (outcome.ok) {
      setSourceNotice(null);
      return;
    }
    setSourceNotice({ noteId, kind: outcome.reason === 'alternate-buffer' ? 'alternate-buffer' : 'unavailable' });
    setOpenNotepadId(surfaceId);
  }, [surfaceId]);

  // A message belongs to the panel that reported it; the next open starts clean.
  useEffect(() => {
    if (!open) setSourceNotice(null);
  }, [open]);

  if (!hasNotepadArchive() || !open) return null;
  return (
    <OpenNotepadPanel
      surfaceId={surfaceId}
      sourceNotice={sourceNotice}
      onRevealSource={revealSource}
    />
  );
}

function OpenNotepadPanel({
  surfaceId,
  sourceNotice,
  onRevealSource,
}: {
  surfaceId: string;
  sourceNotice: SourceNotice | null;
  onRevealSource: (noteId: string) => void;
}) {
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
      onRevealSource={onRevealSource}
    />
  );
}
