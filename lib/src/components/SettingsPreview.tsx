import { useWorkspaceAlertPolicy } from './wall/use-workspace-alert-policy';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { POPUP_SURFACE_CLASS } from './design';
import { AlarmSettingsSection } from './SettingsDialog';
import { AlarmUpsellLine, type UpsellTopic } from './AlarmUpsellLine';
import type { AlertSink } from '../lib/alert-delivery-model';
import type { AlarmUpsell } from '../lib/alarm-upsell';
import { useAnchoredMenu, useCloseOnOutsideAndEscape } from './use-anchored-menu';
import { OVERLAY_VIEWPORT_MARGIN_PX } from '../lib/ui-geometry';

/** How long the preview shows before it fades; also the grace once the line is let go. */
const SHOW_MS = 2000;
/** Long enough to read the live line and reach it. */
const SHOW_WITH_UPSELL_MS = 6000;
const FADE_MS = 250;

/** Remount for every toggle, including repeated clicks on the same setting,
 * so an earlier confirmation's fade/removal cannot retire the newest one. */
export function SettingsPreview({
  sink,
  anchor,
  upsell,
  onShowSettings,
  onClose,
}: {
  sink: AlertSink;
  anchor: HTMLElement;
  /** The one live line under the inert section, once earned (`takeAlarmUpsell`). */
  upsell: AlarmUpsell | null;
  onShowSettings: (topic: UpsellTopic) => void;
  onClose: () => void;
}) {
  const { policy: settings } = useWorkspaceAlertPolicy();
  const [fading, setFading] = useState(false);
  // Hovered or focused, the line holds the preview up.
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
    // A line that arrives as the preview fades brings it back.
    setFading(false);
    if (held) {
      wasHeld.current = true;
      return;
    }
    const show = upsell && !wasHeld.current ? SHOW_WITH_UPSELL_MS : SHOW_MS;
    const fade = window.setTimeout(() => setFading(true), show);
    const close = window.setTimeout(onClose, show + FADE_MS);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(close);
    };
  }, [held, upsell, onClose]);

  // A live line can be dismissed; the Escape or press still reaches the terminal.
  useCloseOnOutsideAndEscape(upsell !== null, lineRef, onClose, { captureKeys: true });

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
          <AlarmUpsellLine upsell={upsell} onShowSettings={onShowSettings} onDone={onClose} />
        </div>
      )}
    </div>,
    document.body,
  );
}
