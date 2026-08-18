import { useEffect, useState, type CSSProperties, type RefObject } from 'react';
import { MODAL_LAYERS, useMeasuredElementRect } from './design';
import { clampOverlayPosition } from '../lib/ui-geometry';

/** Gap between the trigger's bottom edge and the top of the menu. */
const MENU_GAP_PX = 4;

/**
 * Position a dropdown menu off its trigger's measured rect, `position: fixed`.
 *
 * Fixed rather than absolute because the Settings dialog surface is
 * `overflow-y-auto` and would clip an absolutely-positioned menu; a fixed
 * descendant escapes ancestor overflow because no modal ancestor sets
 * `transform`. The menu's own rect feeds the viewport clamp, so a long list
 * can't run off the bottom of a short window — it is 0 on the first pass, which
 * is why the returned style keeps the menu hidden until it has been measured.
 * Any height cap belongs on the panel, not in this style.
 *
 * The style also carries the stacking (`MODAL_LAYERS.app`): inside the Settings
 * dialog the alarm sections' `opacity-50` wrappers are stacking contexts too,
 * and being later in tree order they would otherwise paint through the menu.
 *
 * `open` gates the measurement, so pass `false` for a variant that positions
 * itself some other way (`ThemePicker`'s free-floating `compact`) and ignore
 * `menuStyle` there — such a variant owns its own stacking.
 */
export function useAnchoredMenu(
  open: boolean,
  widthPx: number,
): {
  setTriggerEl: (element: HTMLElement | null) => void;
  setMenuEl: (element: HTMLElement | null) => void;
  menuStyle: CSSProperties;
} {
  const [triggerEl, setTriggerEl] = useState<HTMLElement | null>(null);
  const [menuEl, setMenuEl] = useState<HTMLElement | null>(null);

  const triggerRect = useMeasuredElementRect(open ? triggerEl : null);
  const menuRect = useMeasuredElementRect(open ? menuEl : null);

  const menuStyle: CSSProperties = {
    width: widthPx,
    zIndex: MODAL_LAYERS.app,
    ...(triggerRect
      ? clampOverlayPosition({
          left: triggerRect.left,
          top: triggerRect.top + triggerRect.height + MENU_GAP_PX,
          width: widthPx,
          height: menuRect?.height ?? 0,
        })
      : { position: 'fixed', visibility: 'hidden' }),
  };

  return { setTriggerEl, setMenuEl, menuStyle };
}

/**
 * Close on pointerdown outside the ref, on Escape, or on a scroll that actually
 * moves the dropdown's anchor.
 *
 * The scroll rule is narrower than `wall/use-dismiss-overlay.ts`'s. That one
 * exempts scrolls originating *inside* the overlay; a capture-phase listener on
 * `window` still sees every other scroller in the document, which for this
 * dropdown means a background terminal pane auto-scrolling closes a theme list
 * the user is reading. Only a scroller the trigger actually sits inside can
 * move it, so that is the test — which also exempts the theme list's own
 * `overflow-y-auto` (a descendant, never an ancestor) for free.
 */
export function useCloseOnOutsideAndEscape(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;

    const containedInRef = (target: EventTarget | null): boolean =>
      !!ref.current && target instanceof Node && ref.current.contains(target);

    const closeOnPointerDown = (event: PointerEvent) => {
      if (!containedInRef(event.target)) onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const closeOnScroll = (event: Event) => {
      const root = ref.current;
      // Only a scroller the trigger sits inside can move it. `document` is
      // itself a Node containing everything, so viewport scrolling — which the
      // DOM dispatches at the Document — satisfies this too.
      if (!root || !(event.target instanceof Node)) return;
      if (event.target.contains(root)) onClose();
    };

    window.addEventListener('pointerdown', closeOnPointerDown, true);
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('scroll', closeOnScroll, true);
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown, true);
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('scroll', closeOnScroll, true);
    };
  }, [open, ref, onClose]);
}
