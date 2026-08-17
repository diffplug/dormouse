import { type PointerEvent as ReactPointerEvent } from 'react';
import { BellIcon, SpeakerHighIcon } from '@phosphor-icons/react';
import type { AlertSpeechState, SessionStatus, TodoState } from '../lib/terminal-registry';
import { useTodoPillContent } from './TodoPillBody';
import { bellIconClass } from './bell-icon-class';
import {
  ALERT_SPEECH_TRACKING_CLASS,
  TERMINAL_TOP_RADIUS_CLASS,
  TODO_PILL_TRACKING_CLASS,
  alertSpeakingAnimationClass,
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
  // Only `speaking` takes the whole badge slot, and it is genuinely brief — one
  // utterance. `spoken` persists for as long as the ring goes unattended, which
  // is unbounded, so it may not evict the bell and TODO pill: those are the
  // baseboard's persistent status signals and a Door showing neither would be
  // indistinguishable from a quiet one. It gets a speaker icon beside them
  // instead, plus the inset contrast ring on the Door itself.
  const speaking = speechState === 'speaking';
  const spoken = speechState === 'spoken';

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
        speaking
          ? `bg-alarm-vs-door text-door-bg ${alertSpeakingAnimationClass()}`
          : 'bg-door-bg text-door-fg',
        spoken ? 'shadow-[inset_0_0_0_2px_var(--color-alarm-vs-door)]' : '',
        'text-sm font-medium font-mono',
      ].join(' ')}
      onClick={onClick}
      onPointerDown={onPointerDown}
      title={speechState ? `${title} — ${speechState}` : title}
      aria-label={speechState ? `${title}, ${speechState}` : undefined}
      data-alert-speech-state={speechState}
    >
      <span className="min-w-0 flex-1 truncate">
        {title}
      </span>
      {speaking ? (
        <span
          className={[
            'flex shrink-0 items-center gap-1 text-xs font-bold',
            ALERT_SPEECH_TRACKING_CLASS,
          ].join(' ')}
        >
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
