import { useContext, useRef, type MouseEvent } from 'react';
import { WallActionsContext } from './wall-context';

/** Where a press never begins a keep: every header button but the one marked
 *  as its label (a serving Tool's dev-server chip), and an open editor. */
const HEADER_CONTROLS = 'button:not([data-header-label]), input';

/**
 * Double-clicking a preview slot's Pane header keeps it, as double-clicking a
 * VS Code preview tab does (`docs/specs/layout.md` -> Pane header). The burst's
 * first press decides: inside the header's own DOM (a portaled popover bubbles
 * here only through React) and off its controls. So a double-click on the
 * address keeps, although its first click opened the URL editor under the
 * second, while one inside an editor already open selects a word as usual.
 * Spread the result on the header's root.
 */
export function usePreviewKeep(id: string, preview: boolean, onKeep?: () => void) {
  const actions = useContext(WallActionsContext);
  const armed = useRef(false);
  return {
    onMouseDownCapture: (event: MouseEvent<HTMLElement>) => {
      if (event.detail > 1) return;
      const target = event.target as Element;
      armed.current = event.currentTarget.contains(target) && !target.closest(HEADER_CONTROLS);
    },
    onDoubleClick: () => {
      if (!preview || !armed.current) return;
      onKeep?.();
      actions.onPinPreview?.(id);
    },
  };
}
