import { useWorkspaceAlertPolicy } from './wall/use-workspace-alert-policy';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { POPUP_SURFACE_CLASS } from './design';
import { AlarmSettingsSection } from './SettingsDialog';
import { AlarmUpsellLine } from './AlarmUpsellLine';
import type { AlertSink } from '../lib/alert-delivery-model';
import type { AlarmUpsell } from '../lib/alarm-upsell';
import { useAnchoredMenu } from './use-anchored-menu';
import { OVERLAY_VIEWPORT_MARGIN_PX } from '../lib/ui-geometry';

/** How long the preview shows before it fades, and how long the fade takes. */
const SHOW_MS = 2000;
/** Long enough to read and reach the extra line. */
const SHOW_WITH_UPSELL_MS = 6000;
/** After the pointer or focus leaves the line, time to come back to it. */
const SHOW_AFTER_HOLD_MS = 2000;
const FADE_MS = 250;

/** Remount for every toggle, including repeated clicks on the same setting,
 * so an earlier confirmation's fade/removal cannot retire the newest one. */
export function SettingsPreview({
  sink,
  anchor,
  upsell = null,
  onShowNetwork,
  onClose,
}: {
  sink: AlertSink;
  anchor: HTMLElement;
  /** One live line under the inert section (`docs/specs/alert.md` -> "Settings dialog"). */
  upsell?: AlarmUpsell | null;
  onShowNetwork?: () => void;
  onClose: () => void;
}) {
  const { policy: settings } = useWorkspaceAlertPolicy();
  const [fading, setFading] = useState(false);
  // Hovered or focused, the line holds the preview open.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;
  const wasHeld = useRef(false);
  const lineRef = useRef<HTMLDivElement>(null);
  const { setTriggerEl, setMenuEl, menuStyle } = useAnchoredMenu(true, 416, {
    side: 'above',
    align: 'end',
  });
  useLayoutEffect(() => setTriggerEl(anchor), [anchor, setTriggerEl]);

  useEffect(() => {
    if (held) {
      wasHeld.current = true;
      setFading(false);
      return;
    }
    const show = wasHeld.current ? SHOW_AFTER_HOLD_MS : upsell ? SHOW_WITH_UPSELL_MS : SHOW_MS;
    const fade = window.setTimeout(() => setFading(true), show);
    const close = window.setTimeout(onClose, show + FADE_MS);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(close);
    };
  }, [held, upsell, onClose]);

  // A live line can be dismissed. Capture phase, without stopping anything:
  // the terminal swallows its own keys, and the Escape or click is still its.
  useEffect(() => {
    if (!upsell) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node && lineRef.current?.contains(event.target))) onClose();
    };
    window.addEventListener('keydown', closeOnEscape, true);
    window.addEventListener('pointerdown', closeOnPointerDown, true);
    return () => {
      window.removeEventListener('keydown', closeOnEscape, true);
      window.removeEventListener('pointerdown', closeOnPointerDown, true);
    };
  }, [upsell, onClose]);

  const label = sink === 'speech' ? 'Spoken alarms' : 'Push notifications';
  const enabled = sink === 'speech' ? settings.speakEnabled : settings.pushEnabled;
  return createPortal(
    <div
      ref={setMenuEl}
      role="status"
      className={`${POPUP_SURFACE_CLASS} pointer-events-none overflow-hidden p-4 transition-opacity duration-250 ease-out motion-reduce:transition-none ${fading ? 'opacity-0' : 'opacity-100'}`}
      style={{ ...menuStyle, maxWidth: `calc(100% - ${OVERLAY_VIEWPORT_MARGIN_PX * 2}px)` }}
    >
      <span className="sr-only">{label} {enabled ? 'enabled' : 'disabled'}</span>
      {/* Same section and stored values as Settings, without taking focus or
          adding disappearing controls to the keyboard/accessibility tree. */}
      <div inert aria-hidden="true">
        <AlarmSettingsSection sink={sink} preview />
      </div>
      {upsell && (
        <div
          ref={lineRef}
          className="pointer-events-auto"
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        >
          <AlarmUpsellLine upsell={upsell} onShowNetwork={onShowNetwork ?? onClose} onDone={onClose} />
        </div>
      )}
    </div>,
    document.body,
  );
}
