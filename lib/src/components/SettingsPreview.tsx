import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { POPUP_SURFACE_CLASS } from './design';
import { AlarmSettingsSection, type AlarmSink } from './SettingsDialog';
import { useAnchoredMenu } from './use-anchored-menu';
import { getAlertSettings, subscribeToAlertSettings } from '../lib/terminal-registry';
import { OVERLAY_VIEWPORT_MARGIN_PX } from '../lib/ui-geometry';

/** Remount for every toggle, including repeated clicks on the same setting,
 * so an earlier confirmation's fade/removal cannot retire the newest one. */
export function SettingsPreview({
  sink,
  anchor,
  onClose,
}: {
  sink: AlarmSink;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const settings = useSyncExternalStore(subscribeToAlertSettings, getAlertSettings);
  const [fading, setFading] = useState(false);
  const { setTriggerEl, setMenuEl, menuStyle } = useAnchoredMenu(true, 416, {
    side: 'above',
    align: 'end',
  });
  useLayoutEffect(() => setTriggerEl(anchor), [anchor, setTriggerEl]);

  useEffect(() => {
    const fade = window.setTimeout(() => setFading(true), 2000);
    const close = window.setTimeout(onClose, 2250);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(close);
    };
  }, [onClose]);

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
    </div>,
    document.body,
  );
}
