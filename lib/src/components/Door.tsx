import { useRef, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { BellIcon } from '@phosphor-icons/react';
import type { SessionStatus, TodoState } from '../lib/terminal-registry';
import { useTodoPillContent } from './TodoPillBody';
import { bellIconClass } from './bell-icon-class';
import { TERMINAL_TOP_RADIUS_CLASS, TODO_PILL_TRACKING_CLASS } from './design';

/** Pointer travel (px) before a Door press becomes a drag-out. */
const DOOR_DRAG_THRESHOLD = 5;

export interface DoorProps {
  doorId?: string;
  title: string;
  status?: SessionStatus;
  todo?: TodoState;
  onClick?: () => void;
  /** When provided, a press that travels past the threshold starts a drag-out (the
   *  Wall then hands the pointer to LathHost). Absent → Door stays click-only. */
  onDragStart?: () => void;
}

/** Threshold-gated drag detection for a Door. Below the threshold the press is a plain
 *  click (reattach); once crossed it fires `onDragStart` and suppresses the ensuing
 *  click so it does not also reattach at the old position. Inert when `onDragStart`
 *  is undefined (flag off / non-Lath) — the returned handlers no-op. */
function useDoorDrag(onDragStart?: () => void): {
  onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onClickCapture: (e: ReactMouseEvent<HTMLButtonElement>) => void;
} {
  const stateRef = useRef<{ startX: number; startY: number; dragging: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (!onDragStart || e.button !== 0) return;
    const state = { startX: e.clientX, startY: e.clientY, dragging: false };
    stateRef.current = state;
    const onMove = (ev: PointerEvent): void => {
      if (state.dragging) return;
      if (Math.hypot(ev.clientX - state.startX, ev.clientY - state.startY) < DOOR_DRAG_THRESHOLD) return;
      state.dragging = true;
      suppressClickRef.current = true;
      onDragStart();
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      stateRef.current = null;
      // If a drag started, LathHost handles the drop; if the click never fires, clear
      // the suppress flag so a later real click is not swallowed.
      if (state.dragging) setTimeout(() => { suppressClickRef.current = false; }, 0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onClickCapture = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    e.stopPropagation(); // React capture-phase stop → the bubble-phase onClick never runs
    e.preventDefault();
  };

  return { onPointerDown, onClickCapture };
}

export function Door({
  doorId,
  title,
  status = 'WATCHING_DISABLED',
  todo = false,
  onClick,
  onDragStart,
}: DoorProps) {
  const showBell = status !== 'WATCHING_DISABLED';
  const alertRinging = status === 'ALERT_RINGING';
  const todoPill = useTodoPillContent(todo);
  const drag = useDoorDrag(onDragStart);

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
      {...(onDragStart ? { onPointerDown: drag.onPointerDown, onClickCapture: drag.onClickCapture } : {})}
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
