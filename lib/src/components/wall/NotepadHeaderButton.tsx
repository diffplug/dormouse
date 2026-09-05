import { NotepadIcon } from '@phosphor-icons/react';
import { HeaderActionButton } from '../HeaderActionButton';
import { notepadLabel, useNoteCount, useOpenNotepadId } from '../use-notepad';
import { hasNotepadArchive } from '../../lib/notepad/archive-service';
import { setOpenNotepadId } from '../../lib/notepad/notepad-store';

/**
 * The pane header's notepad toggle, filled while the Surface has notes
 * (docs/specs/notepad.md → "Notepad UI"; `docs/specs/layout.md` → "Pane header"
 * owns where it sits). One component for both headers so the terminal and the
 * browser Surface open the same notepad the same way.
 */
export function NotepadHeaderButton({
  surfaceId,
  hideWhenEmpty = false,
}: {
  surfaceId: string;
  /** The minimal tier: an empty notepad yields its space to the title, one with
   *  notes stays, so notes are never invisible. */
  hideWhenEmpty?: boolean;
}) {
  const notes = useNoteCount(surfaceId);
  const open = useOpenNotepadId() === surfaceId;
  if (!hasNotepadArchive() || (hideWhenEmpty && notes === 0)) return null;

  const label = notepadLabel(notes);
  return (
    <div className="ml-1 shrink-0">
      <HeaderActionButton
        className="flex h-5 min-w-5 items-center justify-center rounded transition-colors shrink-0 hover:bg-current/10"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpenNotepadId(open ? null : surfaceId);
        }}
        ariaLabel={label}
        tooltip={label}
      >
        <NotepadIcon size={14} weight={notes > 0 ? 'fill' : 'regular'} />
      </HeaderActionButton>
    </div>
  );
}
