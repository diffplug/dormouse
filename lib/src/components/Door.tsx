import { type PointerEvent as ReactPointerEvent } from 'react';
import { ToolDirtyIndicator } from './ToolDirtyIndicator';
import { clsx } from 'clsx';
import { SpeakerHighIcon } from '@phosphor-icons/react';
import type { AlertSpeechState, SessionStatus, TodoState } from '../lib/terminal-registry';
import type { BrowserDisplayMode } from './wall/agent-browser-screen';
import { BROWSER_DISPLAY_LABEL, BrowserDisplayIcon } from './wall/BrowserDisplayIcon';
import { useTodoPillContent } from './TodoPillBody';
import type { AlertEpisode } from '../lib/alert-episode';
import { ALERT_RING_LABEL, AlertRingInset, alarmPulseClass, alertRingRow, useAlertRingBurst } from './alert-ring';
import {
  ALERT_SPEECH_TRACKING_CLASS,
  DOOR_TAB_CLASS,
  TERMINAL_TOP_RADIUS_CLASS,
  TODO_PILL_TRACKING_CLASS,
} from './design';

export interface DoorProps {
  doorId?: string;
  title: string;
  /** A browser Surface's display identity (`docs/specs/dor-browser.md` -> Browser
   *  Chrome). Door draws the glyph pair and names it, so the visible and
   *  accessible meanings cannot drift apart. */
  browserDisplay?: BrowserDisplayMode;
  /** Set only for a Tool whose last report says it has unsaved changes. */
  toolDirty?: boolean;
  status?: SessionStatus;
  todo?: TodoState;
  speechState?: AlertSpeechState;
  /** `ActivityState.episode` — the Session's current ringing interval. A new one
   *  replays the alarm ring's arrival burst; `null` while the Session is quiet. */
  episode: AlertEpisode | null;
  onClick?: () => void;
  /** When provided, a primary-button press reports its start point and the Wall begins
   *  an (inactive) LathHost drag — LathHost owns the threshold, click suppression, and
   *  hit-testing from there. A sub-threshold press-release still fires `onClick`
   *  (reattach). Absent → Door stays click-only. */
  onDragPress?: (press: { clientX: number; clientY: number }) => void;
}

/**
 * A minimized Surface on the baseboard. The outer element carries the Door's
 * identity, geometry, and palette — it is what the selection ring and the
 * baseboard's fitting pass measure. Its button reattaches and starts the drag.
 */
export function Door({
  doorId,
  title,
  browserDisplay,
  toolDirty = false,
  status = 'WATCHING_DISABLED',
  todo = false,
  speechState,
  episode,
  onClick,
  onDragPress,
}: DoorProps) {
  const row = alertRingRow(status, speechState);
  const burst = useAlertRingBurst(row, episode);
  const todoPill = useTodoPillContent(todo);
  const speaking = row === 'speaking';
  const spoken = row === 'spoken';
  // Unlabelled or `SPOKEN`, the alarm edge is one inset ring; only the unlabelled
  // row moves, and the burst rides that same element.
  const insetRing = row === 'ringing' || spoken;
  const detail = browserDisplay ? BROWSER_DISPLAY_LABEL[browserDisplay] : undefined;
  const extras = [
    detail,
    row ? ALERT_RING_LABEL[row].door : undefined,
    toolDirty && 'Unsaved changes',
  ].filter(Boolean);
  const nameParts = [title, ...extras];

  const onPointerDown = onDragPress
    ? (e: ReactPointerEvent<HTMLDivElement>): void => {
        if (e.button !== 0) return;
        onDragPress({ clientX: e.clientX, clientY: e.clientY });
      }
    : undefined;

  return (
    <div
      data-door-id={doorId}
      role="group"
      className={clsx(
        DOOR_TAB_CLASS,
        speaking
          ? clsx('bg-alarm-vs-door text-door-bg', alarmPulseClass(false))
          : 'bg-door-bg text-door-fg',
      )}
      onPointerDown={onPointerDown}
      title={nameParts.join(' — ')}
      aria-label={extras.length ? nameParts.join(', ') : undefined}
      data-alert-ring-state={row ?? undefined}
      // Never key this element: Baseboard caches it by `data-door-id` in a
      // layout effect that re-runs only on item/window changes, so replacing it
      // leaves the fitting pass measuring a detached node. Anything that must
      // remount per episode goes on the alarm ring below.
    >
      <button
        type="button"
        className={clsx(
          'flex h-full min-w-0 flex-1 items-center gap-2 overflow-hidden pl-2.5 pr-2.5',
        )}
        onClick={onClick}
      >
        <ToolDirtyIndicator dirty={toolDirty} />
        {browserDisplay && <BrowserDisplayIcon mode={browserDisplay} size={12} />}
        <span className="min-w-0 flex-1 truncate">
          {title}
        </span>
        {/* `spoken` is unbounded (it lasts until the ring clears), so it joins
            the badge cluster instead of replacing it — see docs/specs/layout.md. */}
        {speaking ? (
          <span className={clsx('flex shrink-0 items-center gap-1 text-xs font-bold', ALERT_SPEECH_TRACKING_CLASS)}>
            <SpeakerHighIcon size={13} weight="fill" />
            <span>SPEAKING</span>
          </span>
        ) : (spoken || todoPill.visible) && (
          <span className="flex shrink-0 items-center gap-1.5">
            {spoken && (
              <SpeakerHighIcon size={12} weight="fill" className="text-alarm-vs-door" />
            )}
            {todoPill.visible && (
              <span
                className={`todo-pill-shell text-xs font-semibold ${TODO_PILL_TRACKING_CLASS}`}
                data-flourishing={todoPill.flourishing ? 'true' : 'false'}
              >
                {todoPill.body}
              </span>
            )}
          </span>
        )}
      </button>
      {insetRing && <AlertRingInset ground="door" burst={burst} className={TERMINAL_TOP_RADIUS_CLASS} />}
    </div>
  );
}
