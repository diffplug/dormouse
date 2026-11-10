import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from 'react';
import { flushSync } from 'react-dom';
import {
  ArrowLeftIcon,
  CursorClickIcon,
  CursorTextIcon,
  GearSixIcon,
  HandPointingIcon,
  TerminalWindowIcon,
  TextTIcon,
} from '@phosphor-icons/react';
import { clsx } from 'clsx';
import {
  MobileGestureConfirmDialog,
  MobileGestureRadialMenu,
} from './MobileGestureRadialMenu';
import {
  beginMobileGesture,
  completeMobileGesture,
  displayOriginAwayFromThumb,
  finishMobileGesture,
  MOBILE_GESTURE_COMPLETE_MS,
  MOBILE_GESTURE_IDLE_STATE,
  RADIUS_FADE_START,
  updateMobileGesture,
  type MobileGestureAction,
  type MobileGestureInputId,
  type MobileGesturePoint,
  type MobileGestureTrackingState,
} from '../lib/mobile-gesture-menu';
import { useDynamicPalette } from '../lib/themes/use-dynamic-palette';
import { isComposingKey, isEditableTarget } from '../lib/dom';
import { TouchUiContext } from './touch-ui-context';
import type { BrowserDisplayMode } from './wall/agent-browser-screen';
import { BrowserDisplayIcon } from './wall/BrowserDisplayIcon';
import { ClipboardFailureGlobal } from './ClipboardFailureDialog';
import { chromeButton, MOBILE_BAR_HEIGHT_CLASS, modalActionButton, TODO_PILL_TRACKING_CLASS } from './design';
import { AlertRingInset, alertRingRow, useAlertRingBurst } from './alert-ring';
import type { AlertEpisode } from '../lib/alert-episode';
import { getTerminalInstance, type SessionStatus } from '../lib/terminal-registry';
import { EdgeScrollMotion, isEdgeScrollOrigin, isMobileScrollWheel, scrollMobileTerminal } from '../lib/mobile-terminal-scroll';
import { acknowledgeSession } from '../lib/session-activity-store';
import type { MouseTrackingMode, OverrideState } from '../lib/mouse-selection';
import { TERMINAL_TAP_EVENT, type TerminalTapDetail } from '../lib/terminal-mouse-router';
import { overlayViewportBounds, subscribeOverlayViewport } from '../lib/ui-geometry';

/** What fills the screen: the terminal, or the full-screen session list. */
export type MobileTerminalView = 'terminal' | 'sessions';
export type MobileTerminalTouchMode = 'gestures' | 'selection' | 'cursor';
type PhosphorIcon = ComponentType<{ size?: number; weight?: 'regular' | 'bold' | 'duotone' | 'fill' }>;

/** A heading the session list files a row under — Pocket's is the pane's Workspace. */
export interface MobileTerminalSessionGroup {
  id: string;
  label: string;
}

/** What a Session has: a terminal, a browser alone, or a Tool's browser over its terminal. */
export type MobileSurfaceKind = 'terminal' | 'browser' | 'tool';

export interface MobileTerminalSessionItem {
  id: string;
  /** Absent reads as `terminal`. */
  kind?: MobileSurfaceKind;
  /** How a `browser` or `tool` shows its browser; the desktop's glyphs name it. */
  browserDisplay?: BrowserDisplayMode;
  title: string;
  /** Rows sharing a group list together under its label, in first-row order;
   *  a list whose rows share one group shows no label. */
  group?: MobileTerminalSessionGroup;
  secondary?: string | null;
  active?: boolean;
  status?: SessionStatus;
  /** `ActivityState.episode` — the Session's unresolved summons, retained during
   *  pauses, which anchors the row's arrival burst. */
  episode: AlertEpisode | null;
  todo?: boolean;
}

export const MOBILE_TERMINAL_KEY_SEQUENCES: Record<MobileGestureInputId, string> = {
  ctrlC: '\x03',
  ctrlX: '\x18',
  esc: '\x1b',
  tab: '\x09',
  shiftTab: '\x1b[Z',
  space: ' ',
  enter: '\r',
  shiftEnter: '\x1b[13;2u',
  backspace: '\x7f',
  up: '\x1b[A',
  pageUp: '\x1b[5~',
  down: '\x1b[B',
  pageDown: '\x1b[6~',
  right: '\x1b[C',
  end: '\x1b[F',
  left: '\x1b[D',
  home: '\x1b[H',
};

/**
 * The mouse override one pane gets, from the global touch mode and that pane's
 * *own* mouse reporting.
 *
 * A pure function rather than each consumer's own conditional: touch mode is
 * one UI state for the whole wall, so every mounted pane has to be reconfigured
 * on a change — a pane switched away from that kept `permanent` would swallow
 * the inner program's mouse input for as long as it stayed mounted. Both
 * compositions call it in a loop over their panes
 * (`docs/specs/mobile-terminal-ui.md` -> "Touch mode selector").
 */
export function paneMouseOverride(
  touchMode: MobileTerminalTouchMode,
  reporting: MouseTrackingMode,
): OverrideState {
  return touchMode === 'selection' && reporting !== 'none' ? 'permanent' : 'off';
}

/**
 * Each button shows its icon and `shortLabel`: a phone has no hover tooltip,
 * so `title` alone would leave a mode unnamed.
 */
const TOUCH_MODES: Array<{
  id: MobileTerminalTouchMode;
  label: string;
  shortLabel: string;
  title: string;
  Icon: PhosphorIcon;
}> = [
  { id: 'gestures', label: 'Gestures', shortLabel: 'Gestures', title: 'Gestures: drags send arrow keys', Icon: HandPointingIcon },
  { id: 'selection', label: 'Text selection', shortLabel: 'Select', title: 'Text selection: touches select terminal text', Icon: CursorTextIcon },
  { id: 'cursor', label: 'Mouse', shortLabel: 'Mouse', title: 'Mouse: touches send terminal mouse events', Icon: CursorClickIcon },
];

export interface MobileTerminalUiProps {
  terminal: ReactNode;
  activeView?: MobileTerminalView;
  defaultView?: MobileTerminalView;
  onViewChange?: (view: MobileTerminalView) => void;
  activeTouchMode?: MobileTerminalTouchMode;
  defaultTouchMode?: MobileTerminalTouchMode;
  onTouchModeChange?: (mode: MobileTerminalTouchMode) => void;
  cursorTouchAvailable?: boolean;
  onSendInput?: (data: string) => void;
  onGestureInput?: (input: MobileGestureInputId, data: string) => void;
  onGestureScroll?: (lines: number) => void;
  /** The composer supplies its text; a gesture asks the consumer to read it. */
  onPaste?: (text?: string) => void | Promise<void>;
  sessions?: MobileTerminalSessionItem[];
  onSessionSelect?: (id: string) => void;
  /** The Sessions screen's Settings page; omitted, the screen has no Settings. */
  settings?: ReactNode;
  /**
   * The active Session shows its browser, not its terminal: the bar and the
   * composer go, and touches and keys are the browser's.
   */
  browserShown?: boolean;
  interactive?: boolean;
  /** What heads the Sessions screen, above its own bar: the consumer's way out of the wall. */
  sessionsHeader?: ReactNode;
  fillViewport?: boolean;
  className?: string;
  terminalClassName?: string;
  style?: CSSProperties;
}

/** A physical keyboard's named keys; Enter and Tab take their Shift forms. */
const HARDWARE_KEYS: Partial<Record<string, MobileGestureInputId>> = {
  Enter: 'enter',
  Backspace: 'backspace',
  Escape: 'esc',
  Tab: 'tab',
  PageUp: 'pageUp',
  PageDown: 'pageDown',
  Home: 'home',
  End: 'end',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowRight: 'right',
  ArrowLeft: 'left',
};

/** The keys whose sequence changes under application cursor keys (DECCKM). */
const CURSOR_KEYS: ReadonlySet<MobileGestureInputId> = new Set(['up', 'down', 'right', 'left', 'home', 'end']);

/** What a key sends to a Session: the arrows, Home and End take their `ESC O`
 *  form while its program has application cursor keys on, as xterm's own
 *  encoder does; ncurses' keypad mode matches only that form. */
function terminalKeySequence(id: MobileGestureInputId, sessionId: string | undefined): string {
  const data = MOBILE_TERMINAL_KEY_SEQUENCES[id];
  if (!CURSOR_KEYS.has(id) || !sessionId) return data;
  return getTerminalInstance(sessionId)?.modes.applicationCursorKeysMode ? `\x1bO${data.slice(2)}` : data;
}

/** What a physical keyboard's key sends; null leaves the key to the page. */
function hardwareKeySequence(event: globalThis.KeyboardEvent, sessionId: string | undefined): string | null {
  if (event.metaKey || event.altKey) return null;
  if (event.ctrlKey) {
    const key = event.key.toLowerCase();
    return /^[a-z]$/.test(key) ? String.fromCharCode(key.charCodeAt(0) - 96) : null;
  }
  let id = HARDWARE_KEYS[event.key];
  if (event.shiftKey && id === 'enter') id = 'shiftEnter';
  if (event.shiftKey && id === 'tab') id = 'shiftTab';
  if (id) return terminalKeySequence(id, sessionId);
  // One character, an astral one included; other named keys (`Shift`, `F1`) send nothing.
  return [...event.key].length === 1 ? event.key : null;
}

/** Where a physical key reaches the terminal: nothing focused, or a non-control
 *  element of this composition. A focused field or control keeps its keys. */
function isHardwareKeyTarget(root: HTMLElement, target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target === target.ownerDocument.body) return true;
  if (!root.contains(target)) return false;
  return target.closest('button, input, textarea, select, a[href], [contenteditable="true"]') === null;
}

const MODE_CHIP_CLASS = clsx(
  'flex min-w-0 items-center justify-center gap-1 rounded px-1.5 py-1 font-mono text-xs leading-none transition-colors',
  'focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
  'disabled:pointer-events-none disabled:opacity-35',
);
const MODE_CHIP_SELECTED_CLASS = 'bg-header-active-bg text-header-active-fg shadow-[inset_0_0_0_1px_var(--color-focus-ring)]';
const MODE_CHIP_IDLE_CLASS = 'text-muted hover:bg-header-inactive-bg hover:text-foreground';
/** Concentric-Corners Rule (DESIGN.md): 4px chips at p-1 (4px) need an 8px tray. */
const MODE_TRAY_CLASS = 'rounded-lg bg-terminal-bg p-1 shadow-[inset_0_0_0_1px_var(--color-border)]';

/** The one bar of buttons, at the bottom: the touch modes, then Type — an
 *  action rather than a mode, so it sits in a tray of its own. */
function ModeBar({
  mode,
  cursorAvailable,
  composing,
  disabled,
  onSelect,
  onType,
}: {
  mode: MobileTerminalTouchMode;
  cursorAvailable: boolean;
  composing: boolean;
  disabled: boolean;
  onSelect: (mode: MobileTerminalTouchMode) => void;
  onType: () => void;
}) {
  // The bar acts on the terminal, so it sits on terminal-bg as part of the
  // surface above it.
  return (
    <section
      aria-label="Touch mode"
      className="flex shrink-0 items-center gap-2 bg-terminal-bg px-2 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))]"
    >
      <div className={clsx('grid min-w-0 flex-1 grid-cols-3 gap-1', MODE_TRAY_CLASS)}>
        {TOUCH_MODES.map((item) => {
          const selected = item.id === mode;
          const itemDisabled = disabled || (item.id === 'cursor' && !cursorAvailable);
          const Icon = item.Icon;
          return (
            <button
              key={item.id}
              type="button"
              title={item.title}
              aria-label={item.label}
              aria-pressed={selected}
              disabled={itemDisabled}
              onClick={() => onSelect(item.id)}
              className={clsx(MODE_CHIP_CLASS, selected ? MODE_CHIP_SELECTED_CLASS : MODE_CHIP_IDLE_CLASS)}
            >
              <Icon size={15} weight={selected ? 'bold' : 'regular'} />
              <span className="truncate">{item.shortLabel}</span>
            </button>
          );
        })}
      </div>
      <div className={clsx('flex shrink-0', MODE_TRAY_CLASS)}>
        <button
          type="button"
          title="Type: write a line, then send it"
          aria-label="Type"
          aria-pressed={composing}
          disabled={disabled}
          onClick={onType}
          className={clsx(MODE_CHIP_CLASS, 'px-2.5', composing ? MODE_CHIP_SELECTED_CLASS : MODE_CHIP_IDLE_CLASS)}
        >
          <TextTIcon size={15} weight={composing ? 'bold' : 'regular'} />
          <span>Type</span>
        </button>
      </div>
    </section>
  );
}

const SCREEN_BUTTON_CLASS = 'h-full shrink-0 rounded focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-2px] focus-visible:outline-focus-ring';

/** The full-screen session list the header's Session title opens, with Settings behind its button. */
function SessionsScreen({
  sessions,
  disabled,
  header,
  settings,
  onSelect,
  onClose,
}: {
  sessions: MobileTerminalSessionItem[];
  disabled: boolean;
  header?: ReactNode;
  settings?: ReactNode;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [showSettings, setShowSettings] = useState(false);
  const title = showSettings ? 'Settings' : 'Sessions';
  return (
    <section
      aria-label={title}
      className="absolute inset-0 z-40 flex flex-col bg-header-inactive-bg text-header-inactive-fg"
    >
      {header}
      <header className={clsx('flex shrink-0 items-center border-b border-border font-mono text-sm', MOBILE_BAR_HEIGHT_CLASS)}>
        <button
          type="button"
          aria-label={showSettings ? 'Back to sessions' : 'Back to terminal'}
          onClick={showSettings ? () => setShowSettings(false) : onClose}
          className={chromeButton({ kind: 'window', class: SCREEN_BUTTON_CLASS })}
        >
          <ArrowLeftIcon size={16} />
        </button>
        <h2 className="min-w-0 flex-1 truncate font-semibold">{title}</h2>
        {settings && !showSettings ? (
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className={clsx('flex items-center gap-1.5 px-3 transition-colors hover:bg-current/10', SCREEN_BUTTON_CLASS)}
          >
            <GearSixIcon size={16} aria-hidden="true" />
            Settings
          </button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {showSettings ? settings : <SessionsPane sessions={sessions} disabled={disabled} onSelect={onSelect} />}
      </div>
    </section>
  );
}

/** The Type box, over the top of the terminal. It owns its text, so a
 *  keystroke re-renders only the box; `keptDraft` carries a non-password draft
 *  across a close, so Cancel then Type brings it back. */
function Composer({
  fieldRef,
  keptDraft,
  top,
  disabled,
  onCancel,
  onSend,
}: {
  fieldRef: RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
  keptDraft: RefObject<string>;
  top: number;
  disabled: boolean;
  onCancel: () => void;
  onSend: (text: string, password: boolean) => void;
}) {
  const [draft, setDraft] = useState(() => keptDraft.current);
  const [password, setPassword] = useState(false);
  // A password is never kept to come back unmasked.
  useEffect(() => {
    keptDraft.current = password ? '' : draft;
  }, [draft, keptDraft, password]);
  const send = () => {
    keptDraft.current = '';
    onSend(draft, password);
  };
  // 16px text: iOS zooms the page into any field set smaller.
  const fieldClass = 'block w-full resize-none rounded border border-border bg-app-bg p-2 font-mono text-base text-foreground outline-none focus:border-focus-ring';
  return (
    <div
      data-mobile-composer
      role="dialog"
      aria-label="Type"
      className="absolute inset-x-0 z-30 border-b border-border bg-header-inactive-bg p-2 text-header-inactive-fg shadow-md"
      style={{ top }}
    >
      {password ? (
        <input
          ref={fieldRef as RefObject<HTMLInputElement | null>}
          type="password"
          aria-label="Password"
          value={draft}
          disabled={disabled}
          autoComplete="off"
          enterKeyHint="send"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || isComposingKey(event.nativeEvent)) return;
            event.preventDefault();
            send();
          }}
          className={fieldClass}
        />
      ) : (
        <textarea
          ref={fieldRef as RefObject<HTMLTextAreaElement | null>}
          aria-label="Text to send"
          rows={3}
          value={draft}
          disabled={disabled}
          autoCapitalize="off"
          onChange={(event) => setDraft(event.currentTarget.value)}
          className={fieldClass}
        />
      )}
      <div className="mt-2 flex items-center gap-2 font-mono text-xs">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={password}
            disabled={disabled}
            onChange={(event) => {
              const next = event.currentTarget.checked;
              // The swapped-in field takes focus inside the tap, as Type's does.
              flushSync(() => setPassword(next));
              fieldRef.current?.focus({ preventScroll: true });
            }}
          />
          Password
        </label>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className={modalActionButton({ tone: 'secondary', class: 'px-3 hover:bg-app-bg' })}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={disabled || draft.length === 0}
            onClick={send}
            className={modalActionButton({ tone: 'primary', class: 'px-3' })}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function SessionsPane({
  sessions,
  disabled,
  onSelect,
}: {
  sessions: MobileTerminalSessionItem[];
  disabled: boolean;
  onSelect?: (id: string) => void;
}) {
  if (sessions.length === 0) {
    return (
      <div className="grid h-full place-items-center px-4 text-center font-mono text-sm text-muted">
        No sessions
      </div>
    );
  }

  const rows = (items: MobileTerminalSessionItem[]) => (
    <div className="grid gap-1">
      {items.map((session) => (
        <SessionRow key={session.id} session={session} disabled={disabled} onSelect={onSelect} />
      ))}
    </div>
  );
  const groups = groupSessions(sessions);

  return (
    <div className="p-2">
      {groups.length < 2 ? rows(sessions) : (
        <div className="grid gap-3">
          {groups.map(({ group, items }, index) => (
            // By position: rows with no group and a group whose id is '' are two groups.
            <section key={index} aria-label={group?.label} className="grid gap-1">
              {group ? (
                <h3 className={clsx('truncate px-2 font-mono text-xs font-semibold text-muted', TODO_PILL_TRACKING_CLASS)}>
                  {group.label}
                </h3>
              ) : null}
              {rows(items)}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** Rows by group, each group where its first row falls. Rows with no group
 *  share one unlabelled group, so a list that names none is a single group. */
function groupSessions(
  sessions: MobileTerminalSessionItem[],
): Array<{ group?: MobileTerminalSessionGroup; items: MobileTerminalSessionItem[] }> {
  const groups = new Map<string | undefined, { group?: MobileTerminalSessionGroup; items: MobileTerminalSessionItem[] }>();
  for (const session of sessions) {
    const key = session.group?.id;
    let entry = groups.get(key);
    if (!entry) {
      entry = { group: session.group, items: [] };
      groups.set(key, entry);
    }
    entry.items.push(session);
  }
  return [...groups.values()];
}

/** A row is its own component so it can hold the burst hook; the mobile list has
 *  no speech sink, so the unlabelled row is the only one it ever wears. */
function SessionRow({ session, disabled, onSelect }: {
  session: MobileTerminalSessionItem;
  disabled: boolean;
  onSelect?: (id: string) => void;
}) {
  const active = session.active === true;
  const row = alertRingRow(session.status, null);
  const burst = useAlertRingBurst(row, session.episode);

  return (
    <button
      type="button"
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      onClick={() => onSelect?.(session.id)}
      className={clsx(
        'relative flex min-h-10 min-w-0 items-center gap-2 overflow-hidden rounded px-2 text-left font-mono text-xs transition-colors',
        'focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
        'disabled:pointer-events-none disabled:opacity-60',
        // Rows sit on the header-inactive Sessions screen, so the inactive row recesses
        // to the app pair — the guaranteed app↔inactive delta (theme.md's
        // three-pair rule); surface-raised is unreliable here.
        active
          ? 'bg-header-active-bg text-header-active-fg shadow-[inset_0_0_0_1px_var(--color-focus-ring)]'
          : 'bg-app-bg text-app-fg',
      )}
    >
      {session.kind === 'browser' || session.kind === 'tool'
        ? <BrowserDisplayIcon mode={session.browserDisplay ?? 'iframe'} size={15} />
        : <TerminalWindowIcon size={15} weight={active ? 'bold' : 'regular'} className="shrink-0" />}
      {/* One line, as the header has it; the path gives way before the title. */}
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="min-w-0 truncate font-medium">{session.title}</span>
        {session.secondary ? (
          <span className="min-w-0 shrink-[1000] truncate opacity-70">{session.secondary}</span>
        ) : null}
      </span>
      {session.todo ? (
        <span className="shrink-0 rounded border border-current px-1 py-px text-[0.55rem] font-semibold leading-none tracking-[0.08em]">
          TODO
        </span>
      ) : null}
      {/* No alarm token is computed against `app-bg`, so an inactive row borrows
          the Door's — the nearest recessed ground the palette does cover. */}
      {row && <AlertRingInset ground={active ? 'header-active' : 'door'} burst={burst} className="rounded" />}
    </button>
  );
}

type MobileGestureConfirmationAction = Extract<MobileGestureAction, { kind: 'confirm' }>;

function localPointerPoint(event: PointerEvent<HTMLElement>): MobileGesturePoint {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

/** A press that may yet end as a tap, and the Session it would acknowledge. */
interface PendingTap {
  pointerId: number;
  clientX: number;
  clientY: number;
  sessionId: string;
}

/** Whether a press's pointer is still where a tap stays: inside the radial
 *  menu's `RADIUS_FADE_START`, before any direction has begun to steer. */
function withinTapSlop(tap: PendingTap, event: PointerEvent<HTMLElement>): boolean {
  return Math.hypot(event.clientX - tap.clientX, event.clientY - tap.clientY) <= RADIUS_FADE_START;
}

/** A press inside a portaled descendant (the copy editor) reaches the host's
 *  capture handlers only through React. It is not pane content, so it begins no
 *  touch mode, tap, or keyboard dismissal. Only the press is checked: a press
 *  the host took captures its pointer, and a portaled press forgets the
 *  pending tap, as any new press replaces it. */
function isPortaledTarget(event: SyntheticEvent<HTMLElement>): boolean {
  return !event.currentTarget.contains(event.target as Node);
}

/** A control inside the host (`MobileWall`'s header buttons) or the confirm
 *  dialog is not pane content: it takes its own press. Fields are left out:
 *  xterm's offscreen helper textarea is never what a press lands on. */
function isHostControlTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest('button, a[href], select, [role="button"], [data-mobile-gesture-dialog]') !== null;
}

function consumeNativeTouchOrScrollEvent(event: Event): void {
  if (isMobileScrollWheel(event)) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

/** Mouse mode's touch start and end: a cancelled touch gets no `click`, so a
 *  control inside the host keeps its own. Its `touchmove` is still consumed. */
function consumeCursorTouchEvent(event: Event): void {
  if (isHostControlTarget(event.target)) return;
  consumeNativeTouchOrScrollEvent(event);
}

function isTouchLikePrimaryPointer(event: PointerEvent<HTMLElement>): boolean {
  return event.pointerType !== 'mouse' && event.isPrimary;
}

function targetAtPointer(event: PointerEvent<HTMLElement>): EventTarget {
  const doc = event.currentTarget.ownerDocument;
  return doc.elementFromPoint(event.clientX, event.clientY) ?? event.target;
}

function dispatchMouseFromPointer(
  type: 'mousedown' | 'mousemove' | 'mouseup',
  pointerEvent: PointerEvent<HTMLElement>,
  target: EventTarget,
): void {
  const doc = pointerEvent.currentTarget.ownerDocument;
  const view = doc.defaultView ?? window;
  const mouseEvent = new view.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === 'mouseup' ? 0 : 1,
    clientX: pointerEvent.clientX,
    clientY: pointerEvent.clientY,
    screenX: pointerEvent.screenX,
    screenY: pointerEvent.screenY,
    ctrlKey: pointerEvent.ctrlKey,
    shiftKey: pointerEvent.shiftKey,
    altKey: pointerEvent.altKey,
    metaKey: pointerEvent.metaKey,
  });
  target.dispatchEvent(mouseEvent);
}

const NO_KEYBOARD_INSET = { top: 0, pan: 0 };

/** A rAF plus a set of delayed retries, cancelled as one; a new run
 *  supersedes the last. */
class RetrySchedule {
  private timers: number[] = [];
  private frame: number | null = null;

  run(action: () => void, delays: number[]): void {
    this.cancel();
    this.frame = window.requestAnimationFrame(action);
    this.timers = delays.map((delay) => window.setTimeout(action, delay));
  }

  // Bound so it can be handed straight to an effect cleanup.
  cancel = (): void => {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers = [];
    if (this.frame !== null) {
      window.cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  };
}

export function MobileTerminalUi({
  terminal,
  activeView,
  defaultView = 'terminal',
  onViewChange,
  activeTouchMode,
  defaultTouchMode = 'gestures',
  onTouchModeChange,
  cursorTouchAvailable = false,
  onSendInput,
  onGestureInput,
  onGestureScroll,
  onPaste,
  sessions = [],
  onSessionSelect,
  settings,
  browserShown = false,
  interactive = true,
  sessionsHeader,
  fillViewport = false,
  className,
  terminalClassName,
  style,
}: MobileTerminalUiProps) {
  useDynamicPalette();
  const [internalView, setInternalView] = useState<MobileTerminalView>(defaultView);
  const [internalTouchMode, setInternalTouchMode] = useState<MobileTerminalTouchMode>(defaultTouchMode);
  const view = activeView ?? internalView;
  const touchMode = activeTouchMode ?? internalTouchMode;
  const terminalInteractive = interactive && !browserShown;
  const activeSessionId = sessions.find((session) => session.active)?.id;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const composerFieldRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const keptDraftRef = useRef('');
  const edgeScrollRef = useRef<{ pointerId: number; sessionId: string; motion: EdgeScrollMotion } | null>(null);
  const edgeMomentumFrameRef = useRef<number | null>(null);
  const gestureStateRef = useRef<MobileGestureTrackingState>(MOBILE_GESTURE_IDLE_STATE);
  const completedGesturePointerIdRef = useRef<number | null>(null);
  const gestureCompletionTimerRef = useRef<number | null>(null);
  const cursorPointerIdRef = useRef<number | null>(null);
  const cursorPointerTargetRef = useRef<EventTarget | null>(null);
  const pendingTapRef = useRef<PendingTap | null>(null);
  // Cancelled on unmount, including after test DOM teardown.
  const [blurRetries] = useState(() => new RetrySchedule());
  const [gestureState, setGestureState] = useState<MobileGestureTrackingState>(MOBILE_GESTURE_IDLE_STATE);
  const [pendingGestureConfirmation, setPendingGestureConfirmation] = useState<MobileGestureConfirmationAction | null>(null);
  const [composing, setComposing] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(NO_KEYBOARD_INSET);
  const inset = composing ? keyboardInset : NO_KEYBOARD_INSET;

  const stopEdgeScroll = useCallback(() => {
    edgeScrollRef.current = null;
    if (edgeMomentumFrameRef.current !== null) {
      window.cancelAnimationFrame(edgeMomentumFrameRef.current);
      edgeMomentumFrameRef.current = null;
    }
  }, []);

  const scrollEdgeLines = useCallback((sessionId: string, lines: number, x: number, y: number): boolean => {
    const terminal = sessionId === activeSessionId ? getTerminalInstance(sessionId) : undefined;
    if (!terminal) return false;
    if (!lines) return true;
    const scrolling = scrollMobileTerminal(terminal, lines, x, y);
    onGestureScroll?.(lines);
    return scrolling;
  }, [activeSessionId, onGestureScroll]);

  const sendInput = useCallback((data: string) => {
    if (!interactive || data.length === 0) return;
    onSendInput?.(data);
  }, [interactive, onSendInput]);

  const commitGestureState = useCallback((nextState: MobileGestureTrackingState) => {
    gestureStateRef.current = nextState;
    setGestureState(nextState);
  }, []);

  const clearGestureCompletionTimer = useCallback(() => {
    if (gestureCompletionTimerRef.current === null) return;
    window.clearTimeout(gestureCompletionTimerRef.current);
    gestureCompletionTimerRef.current = null;
  }, []);

  const scheduleGestureCompletionClear = useCallback(() => {
    clearGestureCompletionTimer();
    gestureCompletionTimerRef.current = window.setTimeout(() => {
      gestureCompletionTimerRef.current = null;
      commitGestureState(MOBILE_GESTURE_IDLE_STATE);
    }, MOBILE_GESTURE_COMPLETE_MS);
  }, [clearGestureCompletionTimer, commitGestureState]);

  /** Inside the tap's own handler: iOS opens its keyboard only for a focus a
   *  user gesture makes, so the field is committed and focused in one turn. */
  const openComposer = useCallback(() => {
    if (!interactive) return;
    flushSync(() => setComposing(true));
    composerFieldRef.current?.focus({ preventScroll: true });
  }, [interactive]);

  const closeComposer = useCallback(() => {
    composerFieldRef.current?.blur();
    setComposing(false);
  }, []);

  const configurePaneTextInputs = useCallback(() => {
    const host = terminalHostRef.current;
    if (!host) return;
    for (const input of host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) {
      if (input.inputMode !== 'none') input.inputMode = 'none';
      if (input.autocomplete !== 'off') input.autocomplete = 'off';
      if (!input.readOnly) input.readOnly = true;
      if (input.tabIndex !== -1) input.tabIndex = -1;
    }
  }, []);

  const blurPaneTextInputs = useCallback(() => {
    if (typeof document === 'undefined') return;
    const blurActivePaneInput = () => {
      configurePaneTextInputs();
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return;
      if (!terminalHostRef.current?.contains(active)) return;
      if (isEditableTarget(active)) active.blur();
    };
    // Wall can restore xterm focus in rAF; retry across its focus window. A new
    // blur supersedes the old retries. See mobile-terminal-ui.md.
    blurActivePaneInput();
    blurRetries.run(blurActivePaneInput, [0, 50, 200]);
  }, [blurRetries, configurePaneTextInputs]);

  const setView = useCallback((nextView: MobileTerminalView) => {
    if (activeView === undefined) setInternalView(nextView);
    onViewChange?.(nextView);
  }, [activeView, onViewChange]);

  const setTouchMode = useCallback((nextMode: MobileTerminalTouchMode) => {
    if (nextMode === 'cursor' && !cursorTouchAvailable) return;
    if (activeTouchMode === undefined) setInternalTouchMode(nextMode);
    onTouchModeChange?.(nextMode);
  }, [activeTouchMode, cursorTouchAvailable, onTouchModeChange]);

  /** A password goes as typed; anything else takes the paste path, bracketed
   *  when the app asked, so a TUI never reads the Enter after it as pasted. */
  const sendDraft = useCallback((text: string, password: boolean) => {
    closeComposer();
    if (!interactive || !text) return;
    if (password || !onPaste) {
      sendInput(text);
      sendInput(MOBILE_TERMINAL_KEY_SEQUENCES.enter);
      return;
    }
    void Promise.resolve(onPaste(text)).then(() => sendInput(MOBILE_TERMINAL_KEY_SEQUENCES.enter));
  }, [closeComposer, interactive, onPaste, sendInput]);

  // A physical keyboard types straight into the terminal while the composer is
  // closed and no gesture confirmation is asking. No soft keyboard reaches
  // here: one opens only for a focused field. Its Command+V comes back from
  // the page as a `paste` on the same targets.
  const confirming = pendingGestureConfirmation !== null;
  useEffect(() => {
    if (!terminalInteractive || composing || confirming || view !== 'terminal') return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || event.defaultPrevented || isComposingKey(event)) return;
      if (!isHardwareKeyTarget(root, event.target)) return;
      const sequence = hardwareKeySequence(event, activeSessionId);
      if (!sequence) return;
      event.preventDefault();
      sendInput(sequence);
    };
    const onNativePaste = (event: ClipboardEvent) => {
      const root = rootRef.current;
      if (!root || !onPaste || event.defaultPrevented || !isHardwareKeyTarget(root, event.target)) return;
      const text = event.clipboardData?.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      void onPaste(text);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('paste', onNativePaste);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('paste', onNativePaste);
    };
  }, [activeSessionId, composing, confirming, onPaste, sendInput, terminalInteractive, view]);

  useEffect(() => {
    if (!terminalInteractive || view !== 'terminal') closeComposer();
  }, [closeComposer, terminalInteractive, view]);

  // Panned, never resized: the OS keyboard covers the terminal's bottom rows, so
  // the terminal slides up until they sit just above it, and the composer stays
  // at the top of what is visible. A resize would reflow the Session's TUI.
  useEffect(() => {
    const root = rootRef.current;
    const host = terminalHostRef.current;
    if (!composing || !root || !host) return;
    const update = () => {
      const visible = overlayViewportBounds();
      const rootTop = root.getBoundingClientRect().top;
      const hostBottom = rootTop + host.offsetTop + host.offsetHeight;
      const top = Math.max(0, Math.round(visible.top - rootTop));
      const pan = Math.max(0, Math.round(hostBottom - visible.bottom));
      // iOS fires these through the keyboard's whole animation; most change nothing.
      setKeyboardInset((prev) => (prev.top === top && prev.pan === pan ? prev : { top, pan }));
    };
    update();
    return subscribeOverlayViewport(update);
  }, [composing]);

  const executeGestureAction = useCallback((action: MobileGestureAction | undefined) => {
    if (!action) return;
    if (action.kind === 'input') {
      const data = terminalKeySequence(action.input, activeSessionId);
      // Before sending: the input may leave the screen that credits it.
      onGestureInput?.(action.input, data);
      sendInput(data);
      return;
    }
    if (action.kind === 'text') {
      sendInput(action.text);
      return;
    }
    if (action.kind === 'paste') {
      void onPaste?.();
      return;
    }
    if (action.kind === 'confirm') {
      setPendingGestureConfirmation(action);
    }
  }, [activeSessionId, onGestureInput, onPaste, sendInput]);

  const confirmPendingGestureAction = useCallback(() => {
    if (!pendingGestureConfirmation) return;
    const confirmedAction = pendingGestureConfirmation.action;
    setPendingGestureConfirmation(null);
    executeGestureAction(confirmedAction);
  }, [executeGestureAction, pendingGestureConfirmation]);

  useEffect(() => {
    if (touchMode === 'cursor' && !cursorTouchAvailable) {
      setTouchMode('gestures');
    }
  }, [cursorTouchAvailable, setTouchMode, touchMode]);

  useEffect(() => {
    if (!terminalInteractive) return;
    const host = terminalHostRef.current;
    if (!host) return;
    const options: AddEventListenerOptions = { capture: true, passive: false };
    if (touchMode === 'cursor') {
      host.addEventListener('touchstart', consumeCursorTouchEvent, options);
      host.addEventListener('touchmove', consumeNativeTouchOrScrollEvent, options);
      host.addEventListener('touchend', consumeCursorTouchEvent, options);
      host.addEventListener('touchcancel', consumeCursorTouchEvent, options);
      return () => {
        host.removeEventListener('touchstart', consumeCursorTouchEvent, options);
        host.removeEventListener('touchmove', consumeNativeTouchOrScrollEvent, options);
        host.removeEventListener('touchend', consumeCursorTouchEvent, options);
        host.removeEventListener('touchcancel', consumeCursorTouchEvent, options);
      };
    }
    host.addEventListener('wheel', consumeNativeTouchOrScrollEvent, options);
    host.addEventListener('touchmove', consumeNativeTouchOrScrollEvent, options);
    return () => {
      host.removeEventListener('wheel', consumeNativeTouchOrScrollEvent, options);
      host.removeEventListener('touchmove', consumeNativeTouchOrScrollEvent, options);
    };
  }, [terminalInteractive, touchMode]);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return;
    configurePaneTextInputs();
    const observer = new MutationObserver(configurePaneTextInputs);
    observer.observe(host, {
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [configurePaneTextInputs, terminal]);

  // Also cancels a coast on unmount, rather than keeping an old Session alive
  // through the animation callback after switching away from it.
  useEffect(() => stopEdgeScroll, [activeSessionId, terminalInteractive, touchMode, stopEdgeScroll]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) stopEdgeScroll();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [stopEdgeScroll]);

  useEffect(() => {
    if (touchMode === 'gestures' && terminalInteractive) return;
    stopEdgeScroll();
    clearGestureCompletionTimer();
    commitGestureState(MOBILE_GESTURE_IDLE_STATE);
    setPendingGestureConfirmation(null);
  }, [clearGestureCompletionTimer, commitGestureState, terminalInteractive, touchMode, stopEdgeScroll]);

  useEffect(() => clearGestureCompletionTimer, [clearGestureCompletionTimer]);

  useEffect(() => blurRetries.cancel, [blurRetries]);

  // Select mode's router owns a touch on the terminal and consumes its release,
  // so it reports the tap itself.
  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return;
    const onTap = (event: Event) => {
      const tap = pendingTapRef.current;
      if (tap?.pointerId !== (event as CustomEvent<TerminalTapDetail>).detail?.pointerId) return;
      pendingTapRef.current = null;
      acknowledgeSession(tap.sessionId);
    };
    host.addEventListener(TERMINAL_TAP_EVENT, onTap);
    return () => host.removeEventListener(TERMINAL_TAP_EVENT, onTap);
  }, []);

  const handlePanePointerDownCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    // A second finger may stop a coast, but must not steal a live edge drag.
    if (edgeMomentumFrameRef.current !== null) stopEdgeScroll();
    if (browserShown || isPortaledTarget(event) || isHostControlTarget(event.target)) {
      pendingTapRef.current = null;
      return;
    }
    // A tap acknowledges the active Session, a drag or swipe never
    // (`docs/specs/alert.md` -> Engagement): judged on release, and tracked in
    // capture on the host, before any mode below consumes the press.
    const sessionId = interactive ? activeSessionId : undefined;
    pendingTapRef.current = sessionId
      ? { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, sessionId }
      : null;
    blurPaneTextInputs();
    if (interactive && touchMode === 'cursor' && isTouchLikePrimaryPointer(event)) {
      event.preventDefault();
      event.stopPropagation();
      cursorPointerIdRef.current = event.pointerId;
      cursorPointerTargetRef.current = targetAtPointer(event);
      event.currentTarget.setPointerCapture(event.pointerId);
      dispatchMouseFromPointer('mousedown', event, cursorPointerTargetRef.current);
      return;
    }
    if (!interactive || touchMode !== 'gestures') return;
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    clearGestureCompletionTimer();
    setPendingGestureConfirmation(null);
    completedGesturePointerIdRef.current = null;

    const origin = localPointerPoint(event);
    const rect = event.currentTarget.getBoundingClientRect();
    // The starting point owns the whole drag, even if it later leaves the edge.
    if (sessionId && isEdgeScrollOrigin(origin.x, rect.width)) {
      edgeScrollRef.current = {
        pointerId: event.pointerId, sessionId, motion: new EdgeScrollMotion(event.clientY, event.timeStamp),
      };
      commitGestureState(MOBILE_GESTURE_IDLE_STATE);
      return;
    }
    commitGestureState(beginMobileGesture(event.pointerId, origin, displayOriginAwayFromThumb(origin, rect)));
  }, [activeSessionId, blurPaneTextInputs, clearGestureCompletionTimer, commitGestureState, interactive, browserShown, touchMode, stopEdgeScroll]);

  const handlePanePointerMoveCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const tap = pendingTapRef.current;
    if (tap?.pointerId === event.pointerId && !withinTapSlop(tap, event)) pendingTapRef.current = null;
    if (touchMode === 'cursor' && cursorPointerIdRef.current === event.pointerId && isTouchLikePrimaryPointer(event)) {
      event.preventDefault();
      event.stopPropagation();
      const target = targetAtPointer(event);
      cursorPointerTargetRef.current = target;
      dispatchMouseFromPointer('mousemove', event, target);
      return;
    }

    const scroll = edgeScrollRef.current;
    if (scroll?.pointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
      for (const sample of samples.length ? samples : [event]) {
        scrollEdgeLines(scroll.sessionId, scroll.motion.move(sample.clientY, sample.timeStamp), event.clientX, event.clientY);
      }
      return;
    }
    const state = gestureStateRef.current;
    if (state.phase === 'idle' || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const nextState = updateMobileGesture(state, localPointerPoint(event));
    const result = finishMobileGesture(nextState);
    if (result.action) {
      const completionState = completeMobileGesture(nextState);
      completedGesturePointerIdRef.current = event.pointerId;
      commitGestureState(completionState ?? result.state);
      executeGestureAction(result.action);
      if (completionState) scheduleGestureCompletionClear();
      return;
    }
    commitGestureState(nextState);
  }, [commitGestureState, executeGestureAction, scrollEdgeLines, scheduleGestureCompletionClear, touchMode]);

  const endEdgeScroll = useCallback((event: PointerEvent<HTMLDivElement>): boolean => {
    const scroll = edgeScrollRef.current;
    if (scroll?.pointerId !== event.pointerId) return false;
    event.preventDefault();
    event.stopPropagation();
    edgeScrollRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (event.type === 'pointerup') {
      scrollEdgeLines(scroll.sessionId, scroll.motion.move(event.clientY, event.timeStamp), event.clientX, event.clientY);
      // Mouse drags still work in desktop previews, but do not fling on release.
      if (event.pointerType !== 'mouse' && scroll.motion.release(event.timeStamp)) {
        const { clientX, clientY } = event;
        const coast = (time: number) => {
          edgeMomentumFrameRef.current = null;
          const lines = scroll.motion.step(time);
          if (lines === null || !scrollEdgeLines(scroll.sessionId, lines, clientX, clientY)) return;
          edgeMomentumFrameRef.current = window.requestAnimationFrame(coast);
        };
        edgeMomentumFrameRef.current = window.requestAnimationFrame(coast);
      }
    }
    return true;
  }, [scrollEdgeLines]);

  const handlePanePointerUpCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const tap = pendingTapRef.current;
    if (tap?.pointerId === event.pointerId) {
      pendingTapRef.current = null;
      if (withinTapSlop(tap, event)) acknowledgeSession(tap.sessionId);
    }
    if (endEdgeScroll(event)) return;
    if (cursorPointerIdRef.current === event.pointerId && isTouchLikePrimaryPointer(event)) {
      event.preventDefault();
      event.stopPropagation();
      dispatchMouseFromPointer('mouseup', event, targetAtPointer(event));
      cursorPointerIdRef.current = null;
      cursorPointerTargetRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }

    const state = gestureStateRef.current;
    if (state.phase === 'complete' && state.pointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      completedGesturePointerIdRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (state.phase === 'idle' && completedGesturePointerIdRef.current === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      completedGesturePointerIdRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (state.phase === 'idle' || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.releasePointerCapture(event.pointerId);

    const nextState = updateMobileGesture(state, localPointerPoint(event));
    const result = finishMobileGesture(nextState);
    const completionState = completeMobileGesture(nextState);
    completedGesturePointerIdRef.current = result.action ? event.pointerId : null;
    commitGestureState(completionState ?? result.state);
    executeGestureAction(result.action);
    if (completionState) scheduleGestureCompletionClear();
  }, [commitGestureState, endEdgeScroll, executeGestureAction, scheduleGestureCompletionClear]);

  const handlePaneFocusStartCapture = useCallback((event: SyntheticEvent<HTMLDivElement>) => {
    if (browserShown || isPortaledTarget(event)) return;
    blurPaneTextInputs();
  }, [blurPaneTextInputs, browserShown]);

  const handlePanePointerCancelCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (pendingTapRef.current?.pointerId === event.pointerId) pendingTapRef.current = null;
    if (endEdgeScroll(event)) return;
    if (cursorPointerIdRef.current === event.pointerId && isTouchLikePrimaryPointer(event)) {
      event.preventDefault();
      event.stopPropagation();
      dispatchMouseFromPointer('mouseup', event, cursorPointerTargetRef.current ?? targetAtPointer(event));
      cursorPointerIdRef.current = null;
      cursorPointerTargetRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }

    const state = gestureStateRef.current;
    if (state.phase === 'complete' && state.pointerId === event.pointerId) {
      completedGesturePointerIdRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (completedGesturePointerIdRef.current === event.pointerId) {
      completedGesturePointerIdRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (state.phase === 'idle' || state.pointerId !== event.pointerId) return;
    commitGestureState(MOBILE_GESTURE_IDLE_STATE);
  }, [commitGestureState, endEdgeScroll]);

  return (
    <TouchUiContext.Provider value={true}>
    <div
      ref={rootRef}
      data-mobile-terminal-ui
      className={clsx(
        'relative flex min-h-0 flex-col overflow-hidden bg-app-bg text-app-fg',
        // Not `h-screen`: iOS Safari's 100vh is the toolbar-hidden height,
        // which leaves the mode bar under the toolbar.
        fillViewport ? 'h-dvh' : 'h-full',
        className,
      )}
      style={style}
    >
      <div
        ref={terminalHostRef}
        className={clsx(
          'relative min-h-0 flex-1 overflow-hidden bg-terminal-bg',
          !browserShown && 'touch-none',
          terminalClassName,
        )}
        style={inset.pan ? { transform: `translateY(-${inset.pan}px)` } : undefined}
        onPointerDownCapture={handlePanePointerDownCapture}
        onPointerMoveCapture={handlePanePointerMoveCapture}
        onPointerUpCapture={handlePanePointerUpCapture}
        onPointerCancelCapture={handlePanePointerCancelCapture}
        onMouseDownCapture={handlePaneFocusStartCapture}
        onTouchStartCapture={handlePaneFocusStartCapture}
      >
        <div className="flex h-full min-h-0 flex-col">{terminal}</div>
        <MobileGestureRadialMenu state={gestureState} />
        {pendingGestureConfirmation ? (
          <MobileGestureConfirmDialog
            confirmation={pendingGestureConfirmation.confirmation}
            onCancel={() => setPendingGestureConfirmation(null)}
            onConfirm={confirmPendingGestureAction}
          />
        ) : null}
      </div>

      {browserShown ? null : (
        <ModeBar
          mode={touchMode}
          cursorAvailable={cursorTouchAvailable}
          composing={composing}
          disabled={!interactive}
          onSelect={setTouchMode}
          onType={composing ? closeComposer : openComposer}
        />
      )}

      {composing ? (
        <Composer
          fieldRef={composerFieldRef}
          keptDraft={keptDraftRef}
          top={inset.top}
          disabled={!interactive}
          onCancel={closeComposer}
          onSend={sendDraft}
        />
      ) : null}

      {view === 'sessions' ? (
        <SessionsScreen
          sessions={sessions}
          disabled={!interactive}
          header={sessionsHeader}
          settings={settings}
          onSelect={(id) => {
            onSessionSelect?.(id);
            setView('terminal');
          }}
          onClose={() => setView('terminal')}
        />
      ) : null}
    </div>
    {/* The page's root here: Pocket, the one-time phone page, and the Pocket
        playground mount no `App`, which carries it on the desktop hosts. */}
    <ClipboardFailureGlobal />
    </TouchUiContext.Provider>
  );
}
