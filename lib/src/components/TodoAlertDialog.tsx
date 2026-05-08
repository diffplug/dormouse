import { useLayoutEffect, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from '@phosphor-icons/react';
import { Shortcut } from './design';
import { clampOverlayPosition, pointInConvexPolygon } from '../lib/ui-geometry';
import {
  clearSessionTodo,
  DEFAULT_ACTIVITY_STATE,
  disableSessionAlert,
  dismissOrToggleAlert,
  getActivity,
  getActivitySnapshot,
  markSessionTodo,
  subscribeToActivity,
  toggleSessionAlert,
  toggleSessionTodo,
} from '../lib/terminal-registry';

/**
 * Manages focus trapping, Escape-to-close, and click-outside-to-close for
 * portal-based popovers. Scopes keyboard handling to the popover's DOM subtree
 * so Tab/Escape don't leak to the rest of the app.
 */
function usePopoverFocusTrap(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (!el.contains(e.target as Node)) onClose();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle keys when focus is inside the popover
      if (!el.contains(document.activeElement)) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const focusables = Array.from(
        el.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      );
      if (focusables.length === 0) return;

      const currentIndex = focusables.findIndex((f) => f === document.activeElement);
      const nextIndex = currentIndex === -1
        ? 0
        : (currentIndex + (e.shiftKey ? -1 : 1) + focusables.length) % focusables.length;

      e.preventDefault();
      focusables[nextIndex]?.focus();
    };

    window.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('mousedown', handleMouseDown);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [ref, onClose]);
}

export function TodoAlertDialog({
  triggerRect,
  sessionId,
  onClose,
  onKeyboardActiveChange,
}: {
  triggerRect: DOMRect;
  sessionId: string;
  onClose: () => void;
  onKeyboardActiveChange: (active: boolean) => void;
}) {
  const activityStates = useSyncExternalStore(subscribeToActivity, getActivitySnapshot);
  const activity = activityStates.get(sessionId) ?? DEFAULT_ACTIVITY_STATE;
  const alertEnabled = activity.status !== 'ALERT_DISABLED';
  const dialogRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({
    left: triggerRect.left,
    top: triggerRect.bottom + 8,
  });

  // Clamp the dialog inside the viewport after mount. w-fit makes the width
  // content-driven, so we have to measure before we can clamp.
  useLayoutEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition(clampOverlayPosition({
      left: triggerRect.left,
      top: triggerRect.bottom + 8,
      width: rect.width,
      height: rect.height,
    }));
  }, [triggerRect]);

  usePopoverFocusTrap(dialogRef, onClose);

  // Focus the dialog container itself (not a button inside) so our keyboard
  // handlers fire via `el.contains(document.activeElement)`, without painting
  // a native focus ring on any interactive element.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // Keyboard shortcuts within dialog
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    onKeyboardActiveChange(true);
    const handler = (e: KeyboardEvent) => {
      if (!el.contains(document.activeElement)) return;
      if (e.key === 'a') {
        e.preventDefault();
        e.stopImmediatePropagation();
        dismissOrToggleAlert(sessionId, getActivity(sessionId).status);
      }
      if (e.key === 't') {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleSessionTodo(sessionId);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => {
      onKeyboardActiveChange(false);
      window.removeEventListener('keydown', handler, true);
    };
  }, [sessionId, onKeyboardActiveChange]);

  // Hot area: close when mouse leaves (dialog ∪ funnel from trigger button to dialog top).
  // Only arms after the cursor has entered the hot area, so a keyboard-triggered
  // open (cursor far away) doesn't auto-close on the first unrelated mousemove.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    let armed = false;
    const handler = (e: MouseEvent) => {
      const dialogRect = dialog.getBoundingClientRect();
      const { clientX: x, clientY: y } = e;
      const inDialog = x >= dialogRect.left && x <= dialogRect.right && y >= dialogRect.top && y <= dialogRect.bottom;
      const funnel = [
        { x: triggerRect.left, y: triggerRect.top },
        { x: triggerRect.right, y: triggerRect.top },
        { x: dialogRect.right, y: dialogRect.top },
        { x: dialogRect.left, y: dialogRect.top },
      ];
      const inFunnel = pointInConvexPolygon(x, y, funnel);
      const inside = inDialog || inFunnel;
      if (!armed) {
        if (inside) armed = true;
        return;
      }
      if (!inside) onClose();
    };
    window.addEventListener('mousemove', handler);
    return () => window.removeEventListener('mousemove', handler);
  }, [triggerRect, onClose]);

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="fixed z-[9999] w-fit rounded-lg border border-border bg-surface-raised p-3 shadow-lg focus:outline-none"
      style={position}
      role="dialog"
      aria-modal="true"
      aria-label="TODO and alert settings"
    >
      <button
        type="button"
        aria-label="Close"
        className="absolute right-2 top-2 rounded p-0.5 text-muted hover:bg-foreground/10 hover:text-foreground"
        onClick={onClose}
      >
        <XIcon size={12} weight="bold" />
      </button>

      <div className="mb-3 grid w-fit grid-cols-[auto_auto_auto] items-center gap-x-2 gap-y-2">
        {/* TODO row */}
        <Shortcut>t</Shortcut>
        <span className="text-sm font-medium text-foreground">TODO</span>
        <OnOffSwitch
          on={activity.todo}
          onEnable={() => markSessionTodo(sessionId)}
          onDisable={() => clearSessionTodo(sessionId)}
          label="TODO"
        />

        {/* Alert row */}
        <Shortcut>a</Shortcut>
        <span className="text-sm font-medium text-foreground">alert</span>
        <OnOffSwitch
          on={alertEnabled}
          onEnable={() => toggleSessionAlert(sessionId)}
          onDisable={() => disableSessionAlert(sessionId)}
          label="alert"
        />
      </div>

      {activity.notification && (
        <div className="mb-3 max-w-80 border-t border-border pt-2 text-sm leading-relaxed text-foreground">
          {activity.notification.title && (
            <div className="font-medium break-words">{activity.notification.title}</div>
          )}
          {activity.notification.body && (
            <div className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words text-muted">
              {activity.notification.body}
            </div>
          )}
        </div>
      )}

      <div className="border-t border-border pt-2 text-sm leading-relaxed text-muted">
        When a tab with a ringing alert is selected,<br />
        the alert is cleared and the tab gets a TODO.<br />
        Pressing [Enter] into the tab will clear the TODO.
      </div>
    </div>,
    document.body,
  );
}

function OnOffSwitch({
  on,
  onEnable,
  onDisable,
  label,
}: {
  on: boolean;
  onEnable: () => void;
  onDisable: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`${label} ${on ? 'on' : 'off'}`}
      onClick={() => (on ? onDisable() : onEnable())}
      className="relative inline-flex h-5 w-14 items-center rounded-full border border-border bg-app-bg text-sm font-medium"
    >
      <span
        aria-hidden
        className="absolute inset-y-0.5 w-[calc(50%-2px)] rounded-full bg-header-active-bg/25 transition-transform"
        style={{ transform: on ? 'translateX(2px)' : 'translateX(calc(100% + 2px))' }}
      />
      <span className={['z-10 flex-1 text-center', on ? 'text-header-active-bg' : 'text-muted'].join(' ')}>on</span>
      <span className={['z-10 flex-1 text-center', on ? 'text-muted' : 'text-header-active-bg'].join(' ')}>off</span>
    </button>
  );
}
