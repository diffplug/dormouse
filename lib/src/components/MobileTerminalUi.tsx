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
  CursorClickIcon,
  CursorTextIcon,
  HandPointingIcon,
} from '@phosphor-icons/react';
import { clsx } from 'clsx';
import {
  MobileGestureConfirmDialog,
  MobileGestureRadialMenu,
} from './MobileGestureRadialMenu';
import {
  beginMobileGesture,
  displayOriginAwayFromThumb,
  finishMobileGesture,
  MOBILE_GESTURE_IDLE_STATE,
  updateMobileGesture,
  type MobileGestureAction,
  type MobileGesturePoint,
  type MobileGestureTrackingState,
} from '../lib/mobile-gesture-menu';

export type MobileTerminalKeyboardMode = 'recent' | 'type' | 'draft' | 'keys';
export type MobileTerminalSection = MobileTerminalKeyboardMode;
export type MobileTerminalTouchMode = 'gestures' | 'selection' | 'cursor';

export const MOBILE_TERMINAL_KEY_SEQUENCES = {
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
} as const;

interface TerminalKey {
  id: keyof typeof MOBILE_TERMINAL_KEY_SEQUENCES;
  label: string;
  title: string;
}

const TERMINAL_KEYS: TerminalKey[] = [
  { id: 'esc', label: 'Esc', title: 'Escape' },
  { id: 'tab', label: 'Tab', title: 'Tab' },
  { id: 'space', label: 'Space', title: 'Space' },
  { id: 'enter', label: 'Enter', title: 'Enter' },
  { id: 'left', label: '\u25c0', title: 'Left arrow' },
  { id: 'down', label: '\u25bc', title: 'Down arrow' },
  { id: 'up', label: '\u25b2', title: 'Up arrow' },
  { id: 'right', label: '\u25b6', title: 'Right arrow' },
];

const KEYBOARD_MODES: { id: MobileTerminalKeyboardMode; label: string }[] = [
  { id: 'recent', label: 'Recent' },
  { id: 'type', label: 'Type' },
  { id: 'draft', label: 'Draft' },
  { id: 'keys', label: 'Keys' },
];

const TOUCH_MODES: Array<{
  id: MobileTerminalTouchMode;
  label: string;
  shortLabel: string;
  title: string;
  Icon: ComponentType<{ size?: number; weight?: 'regular' | 'bold' | 'duotone' | 'fill' }>;
}> = [
  { id: 'gestures', label: 'Gestures', shortLabel: 'Gestures', title: 'Gestures: drags send arrow keys', Icon: HandPointingIcon },
  { id: 'selection', label: 'Text selection', shortLabel: 'Select', title: 'Text selection: touches select terminal text', Icon: CursorTextIcon },
  { id: 'cursor', label: 'Cursor', shortLabel: 'Cursor', title: 'Cursor: touches send terminal mouse events', Icon: CursorClickIcon },
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
  onPaste?: () => void | Promise<void>;
  onFocusInput?: () => void;
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
      if (event.shiftKey) return MOBILE_TERMINAL_KEY_SEQUENCES.shiftEnter;
      return MOBILE_TERMINAL_KEY_SEQUENCES.enter;
    case 'Backspace':
      return MOBILE_TERMINAL_KEY_SEQUENCES.backspace;
    case 'Escape':
      return MOBILE_TERMINAL_KEY_SEQUENCES.esc;
    case 'Tab':
      if (event.shiftKey) return MOBILE_TERMINAL_KEY_SEQUENCES.shiftTab;
      return MOBILE_TERMINAL_KEY_SEQUENCES.tab;
    case 'PageUp':
      return MOBILE_TERMINAL_KEY_SEQUENCES.pageUp;
    case 'PageDown':
      return MOBILE_TERMINAL_KEY_SEQUENCES.pageDown;
    case 'Home':
      return MOBILE_TERMINAL_KEY_SEQUENCES.home;
    case 'End':
      return MOBILE_TERMINAL_KEY_SEQUENCES.end;
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

function KeyButton({
  item,
  disabled,
  onPress,
}: {
  item: TerminalKey;
  disabled: boolean;
  onPress: (id: keyof typeof MOBILE_TERMINAL_KEY_SEQUENCES) => void;
}) {
  return (
    <button
      type="button"
      title={item.title}
      disabled={disabled}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => onPress(item.id)}
      className={clsx(
        'flex min-w-0 items-center justify-center rounded border border-border bg-surface-raised font-mono text-foreground transition-colors',
        'hover:bg-header-inactive-bg focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-focus-ring',
        'disabled:pointer-events-none disabled:opacity-60',
        'min-h-14 px-2 text-sm',
      )}
    >
      <span className="truncate">{item.label}</span>
    </button>
  );
}

function KeyboardModeButton({
  id,
  label,
  selected,
  disabled,
  onSelect,
}: {
  id: MobileTerminalKeyboardMode;
  label: string;
  selected: boolean;
  disabled: boolean;
  onSelect: (mode: MobileTerminalKeyboardMode) => void;
}) {
  return (
    <button
      key={id}
      type="button"
      disabled={disabled}
      aria-label={`${label} keyboard mode`}
      aria-current={selected ? 'page' : undefined}
      onClick={() => onSelect(id)}
      className={clsx(
        'min-w-0 rounded px-1.5 py-1 font-mono text-xs leading-none transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-focus-ring',
        'disabled:pointer-events-none disabled:opacity-60',
        selected
          ? 'bg-header-active-bg text-header-active-fg shadow-[inset_0_0_0_1px_var(--color-focus-ring)]'
          : 'text-muted hover:bg-header-inactive-bg hover:text-foreground',
      )}
    >
      <span className="truncate">{label}</span>
    </button>
  );
}

function SelectorLabel({ children }: { children: ReactNode }) {
  return (
    <div className="w-[4.5rem] shrink-0 pl-2 pr-1 font-mono text-[11px] leading-none text-muted">
      {children}
    </div>
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
      className="flex h-12 shrink-0 items-center border-t border-border bg-app-bg"
    >
      <SelectorLabel>Touch</SelectorLabel>
      <div className="mr-2 grid min-w-0 flex-1 grid-cols-3 gap-1 rounded bg-surface-raised p-1 shadow-[inset_0_0_0_1px_var(--color-border)]">
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
      aria-label="Keyboard mode"
      className="flex h-12 shrink-0 items-center border-t border-border bg-app-bg"
    >
      <SelectorLabel>Input</SelectorLabel>
      <nav className="mr-2 grid min-w-0 flex-1 grid-cols-4 gap-1 rounded bg-surface-raised p-1 shadow-[inset_0_0_0_1px_var(--color-border)]">
        {KEYBOARD_MODES.map((item) => (
          <KeyboardModeButton
            key={item.id}
            id={item.id}
            label={item.label}
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

type MobileGestureConfirmationAction = Extract<MobileGestureAction, { kind: 'confirm' }>;

function localPointerPoint(event: PointerEvent<HTMLElement>): MobileGesturePoint {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function isGestureDialogTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-mobile-gesture-dialog]') !== null;
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
  onPaste,
  onFocusInput,
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
  const gestureStateRef = useRef<MobileGestureTrackingState>(MOBILE_GESTURE_IDLE_STATE);
  const [gestureState, setGestureState] = useState<MobileGestureTrackingState>(MOBILE_GESTURE_IDLE_STATE);
  const [pendingGestureConfirmation, setPendingGestureConfirmation] = useState<MobileGestureConfirmationAction | null>(null);
  const [inputValue, setInputValue] = useState('');

  const sendInput = useCallback((data: string) => {
    if (!interactive || data.length === 0) return;
    onSendInput?.(data);
  }, [interactive, onSendInput]);

  const commitGestureState = useCallback((nextState: MobileGestureTrackingState) => {
    gestureStateRef.current = nextState;
    setGestureState(nextState);
  }, []);

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

  const executeGestureAction = useCallback((action: MobileGestureAction | undefined) => {
    if (!action) return;
    if (action.kind === 'input') {
      sendInput(MOBILE_TERMINAL_KEY_SEQUENCES[action.input]);
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
  }, [onPaste, sendInput]);

  const confirmPendingGestureAction = useCallback(() => {
    if (!pendingGestureConfirmation) return;
    const confirmedAction = pendingGestureConfirmation.action;
    setPendingGestureConfirmation(null);
    executeGestureAction(confirmedAction);
  }, [executeGestureAction, pendingGestureConfirmation]);

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

  useEffect(() => {
    if (touchMode === 'gestures' && interactive) return;
    commitGestureState(MOBILE_GESTURE_IDLE_STATE);
    setPendingGestureConfirmation(null);
  }, [commitGestureState, interactive, touchMode]);

  const handlePanePointerDownCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (isGestureDialogTarget(event.target)) return;
    blurPaneTextInputs();
    if (!interactive || touchMode !== 'gestures') return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setPendingGestureConfirmation(null);

    const origin = localPointerPoint(event);
    commitGestureState(beginMobileGesture(
      event.pointerId,
      origin,
      displayOriginAwayFromThumb(origin, event.currentTarget.getBoundingClientRect()),
    ));
  }, [blurPaneTextInputs, commitGestureState, interactive, touchMode]);

  const handlePanePointerMoveCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const state = gestureStateRef.current;
    if (state.phase === 'idle' || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    commitGestureState(updateMobileGesture(state, localPointerPoint(event)));
  }, [commitGestureState]);

  const handlePanePointerUpCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const state = gestureStateRef.current;
    if (state.phase === 'idle' || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const result = finishMobileGesture(updateMobileGesture(state, localPointerPoint(event)));
    commitGestureState(result.state);
    executeGestureAction(result.action);
  }, [commitGestureState, executeGestureAction]);

  const handlePaneFocusStartCapture = useCallback(() => {
    blurPaneTextInputs();
  }, [blurPaneTextInputs]);

  const handlePanePointerCancelCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const state = gestureStateRef.current;
    if (state.phase === 'idle' || state.pointerId !== event.pointerId) return;
    commitGestureState(MOBILE_GESTURE_IDLE_STATE);
  }, [commitGestureState]);

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
          'relative min-h-0 flex-1 overflow-hidden bg-terminal-bg',
          touchMode === 'gestures' ? 'touch-none' : 'touch-auto',
          terminalClassName,
        )}
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

      <div className="h-64 shrink-0 border-t border-border bg-app-bg">
        {keyboardMode === 'recent' ? <WorkInProgressPane label="Recent" /> : null}
        {keyboardMode === 'draft' ? <WorkInProgressPane label="Draft" /> : null}
        {keyboardMode === 'type' ? (
          <button
            type="button"
            disabled={!interactive}
            aria-label="Focus terminal input"
            onClick={focusInput}
            className={clsx(
              'grid h-full w-full place-items-center bg-app-bg text-terminal-fg transition-colors',
              'focus-visible:outline focus-visible:outline-1 focus-visible:outline-inset focus-visible:outline-focus-ring',
              'disabled:pointer-events-none disabled:opacity-60',
            )}
          >
            <span aria-hidden="true" className="font-mono text-3xl leading-none text-focus-ring">▌</span>
          </button>
        ) : null}
        {keyboardMode === 'keys' ? (
          <div className="grid h-full grid-rows-2 gap-2 p-3">
            <div className="grid grid-cols-4 gap-2">
              {TERMINAL_KEYS.slice(0, 4).map((item) => (
                <KeyButton
                  key={item.id}
                  item={item}
                  disabled={!interactive}
                  onPress={(id) => sendInput(MOBILE_TERMINAL_KEY_SEQUENCES[id])}
                />
              ))}
            </div>
            <div className="grid grid-cols-4 gap-2">
              {TERMINAL_KEYS.slice(4).map((item) => (
                <KeyButton
                  key={item.id}
                  item={item}
                  disabled={!interactive}
                  onPress={(id) => sendInput(MOBILE_TERMINAL_KEY_SEQUENCES[id])}
                />
              ))}
            </div>
          </div>
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
