import { useEffect, useState, type CSSProperties, type RefObject } from 'react';
import { MODAL_LAYERS, OVERLAY_MAX_HEIGHT_CSS, useMeasuredElementRect } from './design';
import {
  clampOverlayPosition,
  overlayViewportHeight,
  OVERLAY_VIEWPORT_MARGIN_PX,
} from '../lib/ui-geometry';

/** Gap between the trigger's near edge and the menu. */
const MENU_GAP_PX = 4;

interface AnchoredMenuOptions {
  /** Which side of the trigger the menu prefers. */
  side?: 'above' | 'below';
  /** Which of the menu's edges lines up with the trigger's matching edge. */
  align?: 'start' | 'end';
  /**
   * `fixed` measures the menu and positions it in viewport coordinates;
   * `absolute` offsets it off the trigger in CSS alone.
   *
   * Fixed is the default because the Settings dialog surface is
   * `overflow-y-auto` and would clip an absolutely-positioned menu; a fixed
   * descendant escapes ancestor overflow because no modal ancestor sets
   * `transform`. Absolute is for a trigger inside a `position: sticky`
   * ancestor, which Chromium treats as the containing block for fixed
   * descendants and so offsets them by it.
   */
  strategy?: 'fixed' | 'absolute';
}

/**
 * Position a dropdown menu off its trigger's measured rect.
 *
 * The returned style is the menu's whole geometry — width, stacking, height
 * cap, and placement — so no caller re-implements placement beside it.
 *
 * The height cap reserves the roomier side of the trigger, flipping away from
 * the preferred side when needed; a full-viewport cap alone is too tall once
 * the panel starts below the top edge. Under `fixed` the menu's own rect feeds
 * the final viewport clamp. It is unmeasured on the first pass, which is why
 * the style keeps the menu hidden until then.
 *
 * The style also carries the stacking (`MODAL_LAYERS.app`): inside the Settings
 * dialog the alarm sections' `opacity-50` wrappers are stacking contexts too,
 * and being later in tree order they would otherwise paint through the menu.
 *
 * `open` gates the measurement so closed pickers do not keep observers alive,
 * and `absolute` never measures the menu at all.
 */
export function useAnchoredMenu(
  open: boolean,
  widthPx: number,
  { side = 'below', align = 'start', strategy = 'fixed' }: AnchoredMenuOptions = {},
): {
  setTriggerEl: (element: HTMLElement | null) => void;
  setMenuEl: (element: HTMLElement | null) => void;
  menuStyle: CSSProperties;
} {
  const [triggerEl, setTriggerEl] = useState<HTMLElement | null>(null);
  const [menuEl, setMenuEl] = useState<HTMLElement | null>(null);

  const triggerRect = useMeasuredElementRect(open ? triggerEl : null);
  const menuRect = useMeasuredElementRect(open && strategy === 'fixed' ? menuEl : null);

  // `useMeasuredElementRect` deliberately preserves its object when a resize
  // leaves the element fixed in place. The geometry below still depends on the
  // viewport, so subscribe independently instead of relying on a coincidental
  // rect allocation. `visualViewport` covers mobile browser chrome and the
  // on-screen keyboard on engines that report those separately.
  const [, setViewportRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    const update = () => setViewportRevision((revision) => revision + 1);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, [open]);

  const viewportHeight = triggerRect ? overlayViewportHeight() : null;
  const space = triggerRect && viewportHeight !== null
    ? {
        above: Math.max(0, triggerRect.top - MENU_GAP_PX - OVERLAY_VIEWPORT_MARGIN_PX),
        below: Math.max(
          0,
          viewportHeight
            - (triggerRect.top + triggerRect.height + MENU_GAP_PX)
            - OVERLAY_VIEWPORT_MARGIN_PX,
        ),
        viewportHeight,
      }
    : null;
  const otherSide = side === 'above' ? 'below' : 'above';
  const resolvedSide = space && space[otherSide] > space[side] ? otherSide : side;
  // If a malformed/off-screen trigger leaves no room on either side, fixed
  // placement can still clamp a usable panel over it; never collapse to 0px.
  const availableHeight = space
    ? Math.max(
        space.above,
        space.below,
        space.above === 0 && space.below === 0
          ? space.viewportHeight - OVERLAY_VIEWPORT_MARGIN_PX * 2
          : 0,
      )
    : null;
  const effectiveMenuHeight = menuRect && availableHeight !== null
    ? Math.min(menuRect.height, availableHeight)
    : null;

  const placement: CSSProperties =
    strategy === 'absolute'
      ? {
          position: 'absolute',
          ...(align === 'end' ? { right: 0 } : { left: 0 }),
          ...(resolvedSide === 'above'
            ? { bottom: `calc(100% + ${MENU_GAP_PX}px)` }
            : { top: `calc(100% + ${MENU_GAP_PX}px)` }),
        }
      : triggerRect && menuRect && effectiveMenuHeight !== null
        ? clampOverlayPosition({
            left: align === 'end'
              ? triggerRect.left + triggerRect.width - widthPx
              : triggerRect.left,
            top: resolvedSide === 'above'
              ? triggerRect.top - effectiveMenuHeight - MENU_GAP_PX
              : triggerRect.top + triggerRect.height + MENU_GAP_PX,
            width: widthPx,
            height: effectiveMenuHeight,
          })
        : { position: 'fixed', visibility: 'hidden' };

  const menuStyle: CSSProperties = {
    width: widthPx,
    zIndex: MODAL_LAYERS.app,
    ...(availableHeight === null
      ? null
      : { maxHeight: `min(${OVERLAY_MAX_HEIGHT_CSS.popover}, ${availableHeight}px)` }),
    ...placement,
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
