import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { NotepadBody } from './NotepadBody';
import type { SourceNotice } from './NoteList';
import { useNotes } from './use-notepad';
import { useDialogKeyboardOwner } from './wall/wall-context';
import { clampOverlayPosition } from '../lib/ui-geometry';

/** Gap between the Door's top edge and the popover above it. */
const DOOR_POPOVER_GAP_PX = 4;

/**
 * A minimized Surface's notepad, above its Door (docs/specs/notepad.md →
 * Notepad UI). Same list and same editing as the attached panel — both are
 * `NotepadBody` — so what lives here is only the placement: a portal, measured
 * and edge-clamped above the Door. Opening it never reattaches the Surface, and
 * a pin does; the Baseboard owns that sequence and passes it in.
 */
export function DoorNotepadPopover({
  surfaceId,
  anchorRect,
  sourceNotice,
  onClose,
  onRevealSource,
}: {
  surfaceId: string;
  /** The Door's rect. Measured at open; the popover keeps its place if the
   *  Door goes away under it (a pin reattaches the Surface). */
  anchorRect: DOMRect;
  sourceNotice: SourceNotice | null;
  onClose: () => void;
  onRevealSource: (noteId: string) => void;
}) {
  const notes = useNotes(surfaceId);
  const popoverRef = useRef<HTMLDivElement>(null);
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
  }, [anchorRect, notes, sourceNotice]);

  // Mounted only while open, so the lease is unconditional: it lives exactly as
  // long as the popover, independently of any other dialog's.
  useDialogKeyboardOwner(true);

  return createPortal(
    <NotepadBody
      surfaceId={surfaceId}
      containerRef={popoverRef}
      className="max-h-[75dvh] w-fit max-w-[30rem]"
      style={style}
      dataAttributes={{ 'data-notepad-popover-for': surfaceId }}
      sourceNotice={sourceNotice}
      onClose={onClose}
      onRevealSource={onRevealSource}
    />,
    document.body,
  );
}
