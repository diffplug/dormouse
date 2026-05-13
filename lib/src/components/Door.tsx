import { BellIcon } from '@phosphor-icons/react';
import type { SessionStatus, TodoState } from '../lib/terminal-registry';
import { useTodoPillContent } from './TodoPillBody';
import { bellIconClass } from './bell-icon-class';
import { TERMINAL_TOP_RADIUS_CLASS, TODO_PILL_TRACKING_CLASS } from './design';

export interface DoorProps {
  doorId?: string;
  title: string;
  status?: SessionStatus;
  todo?: TodoState;
  onClick?: () => void;
}

export function Door({
  doorId,
  title,
  status = 'WATCHING_DISABLED',
  todo = false,
  onClick,
}: DoorProps) {
  const showBell = status !== 'WATCHING_DISABLED';
  const alertRinging = status === 'ALERT_RINGING';
  const todoPill = useTodoPillContent(todo);

  return (
    <button
      data-door-id={doorId}
      className={[
        'relative flex h-6 max-w-[220px] min-w-[68px] items-center gap-2 overflow-hidden px-2.5',
        TERMINAL_TOP_RADIUS_CLASS,
        'bg-door-bg text-door-fg',
        'text-sm font-medium font-mono',
      ].join(' ')}
      onClick={onClick}
      title={title}
    >
      <span className="min-w-0 flex-1 truncate">
        {title}
      </span>
      {(todoPill.visible || showBell) && (
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
