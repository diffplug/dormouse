import { useContext } from 'react';
import { TODO_PILL_TRACKING_CLASS } from '../design';
import { WallActionsContext } from './wall-context';

/** The Pane header's mark for a preview slot, drawn like the TODO pill; a click
 *  keeps the slot open (`docs/specs/layout.md` → "Pane header"). */
export function PreviewPill({ id }: { id: string }) {
  const actions = useContext(WallActionsContext);
  return (
    <button
      type="button"
      data-preview-pill-for={id}
      className={`shrink-0 rounded border border-current px-1.5 py-px text-xs font-semibold ${TODO_PILL_TRACKING_CLASS} transition-colors hover:bg-current/10 focus:outline-none`}
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
