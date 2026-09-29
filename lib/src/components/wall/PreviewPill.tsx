import { useContext } from 'react';
import { HEADER_PILL_CLASS } from '../design';
import { WallActionsContext } from './wall-context';

/** The Pane header's mark for a preview slot, drawn like the TODO pill; a click
 *  keeps the slot open (`docs/specs/layout.md` → "Pane header"). */
export function PreviewPill({ id }: { id: string }) {
  const actions = useContext(WallActionsContext);
  return (
    <button
      type="button"
      data-preview-pill-for={id}
      className={HEADER_PILL_CLASS}
      title="Keep open"
      aria-label="Preview — keep open"
      // A press on the pill is not a press on the pane.
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); actions.onPinPreview?.(id); }}
    >
      Preview
    </button>
  );
}
