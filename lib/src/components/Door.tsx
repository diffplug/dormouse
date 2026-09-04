import { type PointerEvent as ReactPointerEvent } from 'react';
import { clsx } from 'clsx';
import { BellIcon, SpeakerHighIcon } from '@phosphor-icons/react';
import type { AlertSpeechState, SessionStatus, TodoState } from '../lib/terminal-registry';
import type { BrowserDisplayMode } from './wall/agent-browser-screen';
import { BROWSER_DISPLAY_LABEL, BrowserDisplayIcon } from './wall/BrowserDisplayIcon';
import { useTodoPillContent } from './TodoPillBody';
import { alertSpeakingAnimationClass, bellIconClass } from './bell-icon-class';
import {
  ALERT_SPEECH_TRACKING_CLASS,
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
  status?: SessionStatus;
  todo?: TodoState;
  speechState?: AlertSpeechState;
  onClick?: () => void;
  /** When provided, a primary-button press reports its start point and the Wall begins
   *  an (inactive) LathHost drag — LathHost owns the threshold, click suppression, and
   *  hit-testing from there. A sub-threshold press-release still fires `onClick`
   *  (reattach). Absent → Door stays click-only. */
  onDragPress?: (press: { clientX: number; clientY: number }) => void;
}

export function Door({
  doorId,
  title,
  browserDisplay,
  status = 'WATCHING_DISABLED',
  todo = false,
  speechState,
  onClick,
  onDragPress,
}: DoorProps) {
  const showBell = status !== 'WATCHING_DISABLED';
  const alertRinging = status === 'ALERT_RINGING';
  const todoPill = useTodoPillContent(todo);
  const speaking = speechState === 'speaking';
  const spoken = speechState === 'spoken';
  const detail = browserDisplay ? BROWSER_DISPLAY_LABEL[browserDisplay] : undefined;
  const nameParts = [title, detail, speechState].filter(Boolean);

  const onPointerDown = onDragPress
    ? (e: ReactPointerEvent<HTMLButtonElement>): void => {
        if (e.button !== 0) return;
        onDragPress({ clientX: e.clientX, clientY: e.clientY });
      }
    : undefined;

  return (
    <button
      data-door-id={doorId}
      className={clsx(
        'relative flex h-6 max-w-[220px] min-w-[68px] items-center gap-2 overflow-hidden px-2.5',
        'text-sm font-medium font-mono',
        TERMINAL_TOP_RADIUS_CLASS,
        speaking
          ? clsx('bg-alarm-vs-door text-door-bg', alertSpeakingAnimationClass())
          : 'bg-door-bg text-door-fg',
        spoken && 'shadow-[inset_0_0_0_2px_var(--color-alarm-vs-door)]',
      )}
      onClick={onClick}
      onPointerDown={onPointerDown}
      title={nameParts.join(' — ')}
      aria-label={detail || speechState ? nameParts.join(', ') : undefined}
      data-alert-speech-state={speechState}
    >
      {browserDisplay && <BrowserDisplayIcon mode={browserDisplay} size={12} />}
      <span className="min-w-0 flex-1 truncate">
        {title}
      </span>
      {/* `spoken` is unbounded (it lasts until the ring is attended), so it joins
          the badge cluster instead of replacing it — see docs/specs/layout.md. */}
      {speaking ? (
        <span className={clsx('flex shrink-0 items-center gap-1 text-xs font-bold', ALERT_SPEECH_TRACKING_CLASS)}>
          <SpeakerHighIcon size={13} weight="fill" />
          <span>SPEAKING</span>
        </span>
      ) : (spoken || todoPill.visible || showBell) && (
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
          {showBell && (
            <span className={alertRinging ? 'text-alarm-vs-door' : ''}>
              <BellIcon size={11} weight="fill" className={bellIconClass(status)} />
            </span>
          )}
        </span>
      )}
    </button>
  );
}
