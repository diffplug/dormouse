import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import {
  ArticleNyTimesIcon,
  BellIcon,
  ClockCounterClockwiseIcon,
  CursorClickIcon,
  CursorTextIcon,
  HandPointingIcon,
  TerminalWindowIcon,
  TextTIcon,
} from '@phosphor-icons/react';
import { clsx } from 'clsx';
import { bellIconClass } from './bell-icon-class';

export type MobileTerminalKeyboardMode = 'sessions' | 'recent' | 'type' | 'draft';
export type MobileTerminalSection = MobileTerminalKeyboardMode;
export type MobileTerminalTouchMode = 'gestures' | 'selection' | 'cursor';
type PhosphorIcon = ComponentType<{ size?: number; weight?: 'regular' | 'bold' | 'duotone' | 'fill' }>;

export interface MobileTerminalSessionItem {
  id: string;
  title: string;
  secondary?: string | null;
  active?: boolean;
  status?: 'ALERT_DISABLED' | 'NOTHING_TO_SHOW' | 'MIGHT_BE_BUSY' | 'BUSY' | 'MIGHT_NEED_ATTENTION' | 'ALERT_RINGING' | 'OSC_NOTIF_BUSY';
  todo?: boolean;
}

export const MOBILE_TERMINAL_KEY_SEQUENCES = {
  ctrlC: '\x03',
  esc: '\x1b',
  tab: '\x09',
  space: ' ',
  enter: '\r',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
} as const;

const KEYBOARD_MODES: Array<{ id: MobileTerminalKeyboardMode; label: string; Icon: PhosphorIcon }> = [
  { id: 'sessions', label: 'Sessions', Icon: TerminalWindowIcon },
  { id: 'recent', label: 'Recent', Icon: ClockCounterClockwiseIcon },
  { id: 'type', label: 'Type', Icon: TextTIcon },
  { id: 'draft', label: 'Draft', Icon: ArticleNyTimesIcon },
];

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
  activeSection?: MobileTerminalKeyboardMode;
  defaultSection?: MobileTerminalKeyboardMode;
  onSectionChange?: (section: MobileTerminalKeyboardMode) => void;
  activeKeyboardMode?: MobileTerminalKeyboardMode;
  defaultKeyboardMode?: MobileTerminalKeyboardMode;
  onKeyboardModeChange?: (mode: MobileTerminalKeyboardMode) => void;
  activeTouchMode?: MobileTerminalTouchMode;
  defaultTouchMode?: MobileTerminalTouchMode;
  onTouchModeChange?: (mode: MobileTerminalTouchMode) => void;
  cursorTouchAvailable?: boolean;
  onSendInput?: (data: string) => void;
  onFocusInput?: () => void;
  sessions?: MobileTerminalSessionItem[];
  onSessionSelect?: (id: string) => void;
  interactive?: boolean;
  fillViewport?: boolean;
  className?: string;
  terminalClassName?: string;
  style?: CSSProperties;
}

function keyDownSequence(event: KeyboardEvent<HTMLTextAreaElement>): string | null {
  if (event.ctrlKey && event.key.toLowerCase() === 'c') {
    return MOBILE_TERMINAL_KEY_SEQUENCES.ctrlC;
  }

  switch (event.key) {
    case 'Enter':
      return MOBILE_TERMINAL_KEY_SEQUENCES.enter;
    case 'Backspace':
      return MOBILE_TERMINAL_KEY_SEQUENCES.backspace;
    case 'Escape':
      return MOBILE_TERMINAL_KEY_SEQUENCES.esc;
    case 'Tab':
      return MOBILE_TERMINAL_KEY_SEQUENCES.tab;
    case 'ArrowUp':
      return MOBILE_TERMINAL_KEY_SEQUENCES.up;
    case 'ArrowDown':
      return MOBILE_TERMINAL_KEY_SEQUENCES.down;
    case 'ArrowRight':
      return MOBILE_TERMINAL_KEY_SEQUENCES.right;
    case 'ArrowLeft':
      return MOBILE_TERMINAL_KEY_SEQUENCES.left;
    default:
      return null;
  }
}

function KeyboardModeButton({
  id,
  label,
  Icon,
  selected,
  disabled,
  onSelect,
}: {
  id: MobileTerminalKeyboardMode;
  label: string;
  Icon: PhosphorIcon;
  selected: boolean;
  disabled: boolean;
  onSelect: (mode: MobileTerminalKeyboardMode) => void;
}) {
  return (
    <button
      key={id}
      type="button"
      disabled={disabled}
      aria-label={`${label} input mode`}
      aria-current={selected ? 'page' : undefined}
      onClick={() => onSelect(id)}
      className={clsx(
        'flex min-w-0 items-center justify-center gap-1 rounded px-1.5 py-1 font-mono text-xs leading-none transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
        'disabled:pointer-events-none disabled:opacity-60',
        selected
          ? 'bg-header-active-bg text-header-active-fg shadow-[inset_0_0_0_1px_var(--color-focus-ring)]'
          : 'text-muted hover:bg-header-inactive-bg hover:text-foreground',
      )}
    >
      <span aria-hidden="true" className="shrink-0">
        <Icon size={15} weight={selected ? 'bold' : 'regular'} />
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function TouchModeSelector({
  mode,
  cursorAvailable,
  disabled,
  onSelect,
}: {
  mode: MobileTerminalTouchMode;
  cursorAvailable: boolean;
  disabled: boolean;
  onSelect: (mode: MobileTerminalTouchMode) => void;
}) {
  return (
    <section
      aria-label="Touch mode"
      className="flex h-9 shrink-0 items-center bg-terminal-bg px-2"
    >
      <div className="grid min-w-0 flex-1 grid-cols-3 gap-1 rounded bg-terminal-bg p-1 shadow-[inset_0_0_0_1px_var(--color-border)]">
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
              className={clsx(
                'flex min-w-0 items-center justify-center gap-1 rounded px-1.5 py-1 font-mono text-xs leading-none transition-colors',
                'focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
                'disabled:pointer-events-none disabled:opacity-35',
                selected
                  ? 'bg-header-active-bg text-header-active-fg shadow-[inset_0_0_0_1px_var(--color-focus-ring)]'
                  : 'text-muted hover:bg-header-inactive-bg hover:text-foreground',
              )}
            >
              <Icon size={15} weight={selected ? 'bold' : 'regular'} />
              <span className="truncate">{item.shortLabel}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function KeyboardModeSelector({
  mode,
  disabled,
  onSelect,
}: {
  mode: MobileTerminalKeyboardMode;
  disabled: boolean;
  onSelect: (mode: MobileTerminalKeyboardMode) => void;
}) {
  return (
    <section
      aria-label="Input mode"
      className="flex h-9 shrink-0 items-center border-t border-border bg-header-inactive-bg px-2 text-header-inactive-fg"
    >
      <nav className="grid min-w-0 flex-1 grid-cols-[1.25fr_repeat(3,minmax(0,1fr))] gap-1 rounded bg-header-inactive-bg p-1 shadow-[inset_0_0_0_1px_var(--color-border)]">
        {KEYBOARD_MODES.map((item) => (
          <KeyboardModeButton
            key={item.id}
            id={item.id}
            label={item.label}
            Icon={item.Icon}
            selected={item.id === mode}
            disabled={disabled}
            onSelect={onSelect}
          />
        ))}
      </nav>
    </section>
  );
}

function WorkInProgressPane({ label }: { label: 'Recent' | 'Draft' }) {
  return (
    <div className="grid h-full place-items-center px-4 text-center font-mono text-sm text-muted">
      {label} - WIP
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

  return (
    <div className="h-full overflow-auto p-2">
      <div className="grid gap-1">
        {sessions.map((session) => {
          const active = session.active === true;
          const ringing = session.status === 'ALERT_RINGING' || session.status === 'MIGHT_NEED_ATTENTION';
          return (
            <button
              key={session.id}
              type="button"
              disabled={disabled}
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelect?.(session.id)}
              className={clsx(
                'flex min-h-10 min-w-0 items-center gap-2 rounded px-2 text-left font-mono text-xs transition-colors',
                'focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
                'disabled:pointer-events-none disabled:opacity-60',
                active
                  ? 'bg-header-active-bg text-header-active-fg shadow-[inset_0_0_0_1px_var(--color-focus-ring)]'
                  : 'bg-surface-raised text-foreground hover:bg-header-inactive-bg',
              )}
            >
              <TerminalWindowIcon size={15} weight={active ? 'bold' : 'regular'} className="shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{session.title}</span>
                {session.secondary ? (
                  <span className={clsx('block truncate', active ? 'opacity-70' : 'text-muted')}>{session.secondary}</span>
                ) : null}
              </span>
              {session.todo ? (
                <span className="shrink-0 rounded border border-current px-1 py-px text-[0.55rem] font-semibold leading-none tracking-[0.08em]">
                  TODO
                </span>
              ) : null}
              {ringing ? (
                <BellIcon
                  size={14}
                  weight="fill"
                  className={clsx(
                    'shrink-0',
                    active ? 'text-alarm-vs-header-active' : 'text-alarm-vs-door',
                    bellIconClass(session.status ?? 'ALERT_RINGING'),
                  )}
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function MobileTerminalUi({
  terminal,
  activeSection,
  defaultSection = 'type',
  onSectionChange,
  activeKeyboardMode,
  defaultKeyboardMode,
  onKeyboardModeChange,
  activeTouchMode,
  defaultTouchMode = 'gestures',
  onTouchModeChange,
  cursorTouchAvailable = false,
  onSendInput,
  onFocusInput,
  sessions = [],
  onSessionSelect,
  interactive = true,
  fillViewport = false,
  className,
  terminalClassName,
  style,
}: MobileTerminalUiProps) {
  const resolvedDefaultKeyboardMode = defaultKeyboardMode ?? defaultSection;
  const [internalKeyboardMode, setInternalKeyboardMode] = useState<MobileTerminalKeyboardMode>(resolvedDefaultKeyboardMode);
  const [internalTouchMode, setInternalTouchMode] = useState<MobileTerminalTouchMode>(defaultTouchMode);
  const keyboardMode = activeKeyboardMode ?? activeSection ?? internalKeyboardMode;
  const touchMode = activeTouchMode ?? internalTouchMode;
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const gestureStartRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const [inputValue, setInputValue] = useState('');

  const sendInput = useCallback((data: string) => {
    if (!interactive || data.length === 0) return;
    onSendInput?.(data);
  }, [interactive, onSendInput]);

  const focusInput = useCallback(() => {
    if (!interactive) return;
    onFocusInput?.();
    inputRef.current?.focus({ preventScroll: true });
  }, [interactive, onFocusInput]);

  const blurInput = useCallback(() => {
    inputRef.current?.blur();
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
      inputRef.current?.blur();
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return;
      if (!terminalHostRef.current?.contains(active)) return;
      if (
        active instanceof HTMLInputElement
        || active instanceof HTMLTextAreaElement
        || active.isContentEditable
      ) {
        active.blur();
      }
    };
    blurActivePaneInput();
    window.setTimeout(blurActivePaneInput, 0);
    window.setTimeout(blurActivePaneInput, 50);
    window.setTimeout(blurActivePaneInput, 200);
    window.requestAnimationFrame(blurActivePaneInput);
  }, [configurePaneTextInputs]);

  const setKeyboardMode = useCallback((nextMode: MobileTerminalKeyboardMode) => {
    if (activeKeyboardMode === undefined && activeSection === undefined) {
      setInternalKeyboardMode(nextMode);
    }
    onKeyboardModeChange?.(nextMode);
    onSectionChange?.(nextMode);
    if (nextMode === 'type') {
      focusInput();
    } else {
      blurInput();
    }
  }, [activeKeyboardMode, activeSection, blurInput, focusInput, onKeyboardModeChange, onSectionChange]);

  const setTouchMode = useCallback((nextMode: MobileTerminalTouchMode) => {
    if (nextMode === 'cursor' && !cursorTouchAvailable) return;
    if (activeTouchMode === undefined) setInternalTouchMode(nextMode);
    onTouchModeChange?.(nextMode);
  }, [activeTouchMode, cursorTouchAvailable, onTouchModeChange]);

  const flushInputValue = useCallback((value: string) => {
    if (value) sendInput(value);
    setInputValue('');
  }, [sendInput]);

  useEffect(() => {
    if (keyboardMode !== 'type' || !interactive) return;
    const frame = window.requestAnimationFrame(focusInput);
    const delayedFocus = window.setTimeout(focusInput, 120);
    const settledFocus = window.setTimeout(focusInput, 500);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(delayedFocus);
      window.clearTimeout(settledFocus);
    };
  }, [focusInput, interactive, keyboardMode]);

  useEffect(() => {
    if (touchMode === 'cursor' && !cursorTouchAvailable) {
      setTouchMode('gestures');
    }
  }, [cursorTouchAvailable, setTouchMode, touchMode]);

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

  const handlePanePointerDownCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    blurPaneTextInputs();
    if (!interactive || touchMode !== 'gestures') return;
    if (event.pointerType === 'mouse') return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureStartRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }, [interactive, touchMode]);

  const handlePanePointerUpCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const start = gestureStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    gestureStartRef.current = null;
    event.preventDefault();
    event.stopPropagation();

    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    if (Math.abs(dx) > Math.abs(dy)) {
      sendInput(dx < 0 ? MOBILE_TERMINAL_KEY_SEQUENCES.left : MOBILE_TERMINAL_KEY_SEQUENCES.right);
    } else {
      sendInput(dy < 0 ? MOBILE_TERMINAL_KEY_SEQUENCES.up : MOBILE_TERMINAL_KEY_SEQUENCES.down);
    }
  }, [sendInput]);

  const handlePaneFocusStartCapture = useCallback(() => {
    blurPaneTextInputs();
  }, [blurPaneTextInputs]);

  const handlePanePointerCancelCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (gestureStartRef.current?.pointerId === event.pointerId) {
      gestureStartRef.current = null;
    }
  }, []);

  return (
    <div
      data-mobile-terminal-ui
      className={clsx(
        'relative flex min-h-0 flex-col overflow-hidden bg-app-bg text-app-fg',
        fillViewport ? 'h-screen' : 'h-full',
        className,
      )}
      style={style}
    >
      <div
        ref={terminalHostRef}
        className={clsx(
          'min-h-0 flex-1 overflow-hidden bg-terminal-bg',
          touchMode === 'gestures' ? 'touch-none' : 'touch-auto',
          terminalClassName,
        )}
        onPointerDownCapture={handlePanePointerDownCapture}
        onPointerUpCapture={handlePanePointerUpCapture}
        onPointerCancelCapture={handlePanePointerCancelCapture}
        onMouseDownCapture={handlePaneFocusStartCapture}
        onTouchStartCapture={handlePaneFocusStartCapture}
      >
        <div className="flex h-full min-h-0 flex-col">{terminal}</div>
      </div>

      <TouchModeSelector
        mode={touchMode}
        cursorAvailable={cursorTouchAvailable}
        disabled={!interactive}
        onSelect={setTouchMode}
      />

      <KeyboardModeSelector
        mode={keyboardMode}
        disabled={!interactive}
        onSelect={setKeyboardMode}
      />

      <div className="h-64 shrink-0 bg-header-inactive-bg text-header-inactive-fg">
        {keyboardMode === 'sessions' ? (
          <SessionsPane
            sessions={sessions}
            disabled={!interactive}
            onSelect={(id) => {
              onSessionSelect?.(id);
              blurInput();
            }}
          />
        ) : null}
        {keyboardMode === 'recent' ? <WorkInProgressPane label="Recent" /> : null}
        {keyboardMode === 'draft' ? <WorkInProgressPane label="Draft" /> : null}
        {keyboardMode === 'type' ? (
          <button
            type="button"
            disabled={!interactive}
            aria-label="Focus terminal input"
            onClick={focusInput}
            className={clsx(
              'grid h-full w-full place-items-center bg-header-inactive-bg text-header-inactive-fg transition-colors',
              'focus-visible:outline focus-visible:outline-1 focus-visible:outline-inset focus-visible:outline-focus-ring',
              'disabled:pointer-events-none disabled:opacity-60',
            )}
          >
            <span aria-hidden="true" className="font-mono text-3xl leading-none text-focus-ring">▌</span>
          </button>
        ) : null}
      </div>

      <textarea
        ref={inputRef}
        aria-label="Terminal input"
        value={inputValue}
        disabled={!interactive}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode="text"
        enterKeyHint="enter"
        onKeyDown={(event) => {
          const sequence = keyDownSequence(event);
          if (!sequence) return;
          event.preventDefault();
          sendInput(sequence);
          setInputValue('');
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event) => {
          composingRef.current = false;
          flushInputValue(event.currentTarget.value);
        }}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (composingRef.current) {
            setInputValue(value);
          } else {
            flushInputValue(value);
          }
        }}
        className="absolute left-0 top-0 h-px w-px resize-none overflow-hidden border-0 bg-transparent p-0 opacity-0 outline-none"
      />
    </div>
  );
}
