import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { clsx } from 'clsx';
import { NotepadIcon, SpeakerHighIcon } from '@phosphor-icons/react';
import type { AlertSpeechState, SessionStatus, TodoState } from '../lib/terminal-registry';
import type { BrowserDisplayMode } from './wall/agent-browser-screen';
import { BROWSER_DISPLAY_LABEL, BrowserDisplayIcon } from './wall/BrowserDisplayIcon';
import { useTodoPillContent } from './TodoPillBody';
import { alertSpeakingAnimationClass } from './bell-icon-class';
import { AlertBell } from './AlertBell';
import { notepadLabel } from './use-notepad';
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
  /** `ActivityState.ringSeq`; a change replays the ringing burst. */
  ringSeq: number;
  todo?: TodoState;
  speechState?: AlertSpeechState;
  /** Live notes on the minimized Surface. Above zero the Door grows its second
   *  button; a Door with no notes needs none (`docs/specs/notepad.md`). The
   *  Baseboard reports zero on a host that has no notepad at all. */
  noteCount?: number;
  onClick?: () => void;
  /** When provided, a primary-button press reports its start point and the Wall begins
   *  an (inactive) LathHost drag — LathHost owns the threshold, click suppression, and
   *  hit-testing from there. A sub-threshold press-release still fires `onClick`
   *  (reattach). Absent → Door stays click-only. */
  onDragPress?: (press: { clientX: number; clientY: number }) => void;
  /** Opens the Door's notepad popover, anchored on the whole Door. Neither this
   *  press nor its click reattaches the Surface. */
  onOpenNotepad?: (anchor: HTMLElement) => void;
}

/**
 * A minimized Surface on the baseboard. The outer element carries the Door's
 * identity, geometry, and palette — it is what the selection ring and the
 * baseboard's fitting pass measure — and holds one or two buttons: the title,
 * which reattaches and starts the drag, and (with notes) the notepad, which
 * does neither.
 */
export function Door({
  doorId,
  title,
  browserDisplay,
  status = 'WATCHING_DISABLED',
  ringSeq,
  todo = false,
  speechState,
  noteCount = 0,
  onClick,
  onDragPress,
  onOpenNotepad,
}: DoorProps) {
  const showBell = status !== 'WATCHING_DISABLED';
  const alertRinging = status === 'ALERT_RINGING';
  const todoPill = useTodoPillContent(todo);
  const speaking = speechState === 'speaking';
  const spoken = speechState === 'spoken';
  const detail = browserDisplay ? BROWSER_DISPLAY_LABEL[browserDisplay] : undefined;
  const nameParts = [title, detail, speechState].filter(Boolean);
  const doorRef = useRef<HTMLDivElement>(null);
  const showNotepad = noteCount > 0;

  const onPointerDown = onDragPress
    ? (e: ReactPointerEvent<HTMLDivElement>): void => {
        if (e.button !== 0) return;
        // The notepad button sits inside the Door's pill but drags nothing.
        if (e.target instanceof Element && e.target.closest('[data-door-notepad-for]')) return;
        onDragPress({ clientX: e.clientX, clientY: e.clientY });
      }
    : undefined;

  return (
    <div
      ref={doorRef}
      data-door-id={doorId}
      // A labelled group rather than a bare div: with two buttons inside, the
      // display/speech detail belongs to the Door, not to either button.
      role="group"
      className={clsx(
        'relative flex h-6 max-w-[220px] min-w-[68px] items-center overflow-hidden',
        'text-sm font-medium font-mono',
        TERMINAL_TOP_RADIUS_CLASS,
        speaking
          ? clsx('bg-alarm-vs-door text-door-bg', alertSpeakingAnimationClass())
          : 'bg-door-bg text-door-fg',
        spoken && 'shadow-[inset_0_0_0_2px_var(--color-alarm-vs-door)]',
      )}
      onPointerDown={onPointerDown}
      title={nameParts.join(' — ')}
      aria-label={detail || speechState ? nameParts.join(', ') : undefined}
      data-alert-speech-state={speechState}
    >
      <button
        type="button"
        className={clsx(
          'flex h-full min-w-0 flex-1 items-center gap-2 overflow-hidden pl-2.5',
          showNotepad ? 'pr-1' : 'pr-2.5',
        )}
        onClick={onClick}
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
                <AlertBell status={status} ringSeq={ringSeq} size={11} />
              </span>
            )}
          </span>
        )}
      </button>
      {showNotepad && (
        <button
          type="button"
          data-door-notepad-for={doorId}
          className="flex h-full shrink-0 items-center rounded pl-0.5 pr-2 hover:bg-current/10"
          aria-label={notepadLabel(noteCount)}
          title={notepadLabel(noteCount)}
          // Keep the press to itself: the popover's own outside-click dismissal
          // would otherwise close it on the very press that opens it.
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (doorRef.current) onOpenNotepad?.(doorRef.current);
          }}
        >
          <NotepadIcon size={12} weight="fill" />
        </button>
      )}
    </div>
  );
}
