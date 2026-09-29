import { useContext, useRef, type MouseEvent } from 'react';
import { WallActionsContext } from './wall-context';

/** Where a press never begins a keep: a header control, or an open editor. */
const HEADER_CONTROLS = 'button, input';

/**
 * Double-clicking a preview slot's Pane header keeps it, as double-clicking a
 * VS Code preview tab does (`docs/specs/layout.md` -> Pane header). The burst's
 * first press decides: inside the header's own DOM (a portaled popup bubbles
 * here only through React) and off its controls, so a double-click inside an
 * open rename selects a word as usual. Spread the result on the header's root.
 */
export function usePreviewKeep(id: string, preview: boolean) {
  const actions = useContext(WallActionsContext);
  const armed = useRef(false);
  return {
    onMouseDownCapture: (event: MouseEvent<HTMLElement>) => {
      if (event.detail > 1) return;
      const target = event.target as Element;
      armed.current = event.currentTarget.contains(target) && !target.closest(HEADER_CONTROLS);
    },
    onDoubleClick: () => {
      if (preview && armed.current) actions.onPinPreview?.(id);
    },
  };
}
