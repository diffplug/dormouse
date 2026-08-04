import { type PointerEvent as ReactPointerEvent } from 'react';
import { BellIcon, SpeakerHighIcon } from '@phosphor-icons/react';
import type { AlertSpeechState, SessionStatus, TodoState } from '../lib/terminal-registry';
import { useTodoPillContent } from './TodoPillBody';
import { bellIconClass } from './bell-icon-class';
import {
  ALERT_SPEAKING_ANIMATION_CLASS,
  ALERT_SPEECH_TRACKING_CLASS,
  TERMINAL_TOP_RADIUS_CLASS,
  TODO_PILL_TRACKING_CLASS,
} from './design';

export interface DoorProps {
  doorId?: string;
  title: string;
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
  status = 'WATCHING_DISABLED',
  todo = false,
  speechState,
  onClick,
  onDragPress,
}: DoorProps) {
  const showBell = status !== 'WATCHING_DISABLED';
  const alertRinging = status === 'ALERT_RINGING';
  const todoPill = useTodoPillContent(todo);
  const speechLabel = speechState === 'speaking' ? 'SPEAKING' : speechState === 'spoken' ? 'SPOKEN' : null;

  const onPointerDown = onDragPress
    ? (e: ReactPointerEvent<HTMLButtonElement>): void => {
        if (e.button !== 0) return;
        onDragPress({ clientX: e.clientX, clientY: e.clientY });
      }
    : undefined;

  return (
    <button
      data-door-id={doorId}
      className={[
        'relative flex h-6 max-w-[220px] min-w-[68px] items-center gap-2 overflow-hidden px-2.5',
        TERMINAL_TOP_RADIUS_CLASS,
        speechState === 'speaking'
          ? `bg-alarm-vs-door text-door-bg ${ALERT_SPEAKING_ANIMATION_CLASS}`
          : 'bg-door-bg text-door-fg',
        speechState === 'spoken'
          ? 'shadow-[inset_0_0_0_2px_var(--color-alarm-vs-door)]'
          : '',
        'text-sm font-medium font-mono',
      ].join(' ')}
      onClick={onClick}
      onPointerDown={onPointerDown}
      title={speechLabel ? `${title} — ${speechLabel.toLowerCase()}` : title}
      aria-label={speechLabel ? `${title}, ${speechLabel.toLowerCase()}` : undefined}
      data-alert-speech-state={speechState}
    >
      <span className="min-w-0 flex-1 truncate">
        {title}
      </span>
      {speechLabel ? (
        <span
          className={[
            'flex shrink-0 items-center gap-1 text-xs font-bold',
            ALERT_SPEECH_TRACKING_CLASS,
            speechState === 'spoken' ? 'text-alarm-vs-door' : '',
          ].join(' ')}
        >
          <SpeakerHighIcon size={13} weight="fill" />
          <span>{speechLabel}</span>
        </span>
      ) : (todoPill.visible || showBell) && (
        <span className="flex shrink-0 items-center gap-1.5">
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
