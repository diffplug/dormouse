import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { clsx } from 'clsx';

export type MobileTerminalSection = 'recent' | 'type' | 'draft' | 'keys';

export const MOBILE_TERMINAL_KEY_SEQUENCES = {
  ctrlC: '\x03',
  esc: '\x1b',
  tab: '\x09',
  enter: '\r',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
} as const;

interface TerminalKey {
  id: keyof typeof MOBILE_TERMINAL_KEY_SEQUENCES;
  label: string;
  title: string;
}

const TERMINAL_KEYS: TerminalKey[] = [
  { id: 'esc', label: 'Esc', title: 'Escape' },
  { id: 'tab', label: 'Tab', title: 'Tab' },
  { id: 'ctrlC', label: 'Ctrl+C', title: 'Interrupt' },
  { id: 'left', label: '\u2190', title: 'Left arrow' },
  { id: 'down', label: '\u2193', title: 'Down arrow' },
  { id: 'up', label: '\u2191', title: 'Up arrow' },
  { id: 'right', label: '\u2192', title: 'Right arrow' },
];

const NAV_ITEMS: { id: MobileTerminalSection; label: string }[] = [
  { id: 'recent', label: 'Recent' },
  { id: 'type', label: 'Type' },
  { id: 'draft', label: 'Draft' },
  { id: 'keys', label: 'Keys' },
];

type MobileTerminalStyle = CSSProperties & {
  '--mobile-terminal-visible-height'?: string;
};

export interface MobileTerminalUiProps {
  terminal: ReactNode;
  activeSection?: MobileTerminalSection;
  defaultSection?: MobileTerminalSection;
  onSectionChange?: (section: MobileTerminalSection) => void;
  onSendInput?: (data: string) => void;
  onFocusInput?: () => void;
  interactive?: boolean;
  fillViewport?: boolean;
  className?: string;
  terminalClassName?: string;
  style?: CSSProperties;
}

function useVisualViewportHeight(enabled: boolean): number | null {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const update = () => {
      setHeight(window.visualViewport?.height ?? window.innerHeight);
    };

    update();
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);

    return () => {
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [enabled]);

  return height;
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

function KeyButton({
  item,
  size,
  disabled,
  onPress,
}: {
  item: TerminalKey;
  size: 'compact' | 'large';
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
        size === 'compact'
          ? 'min-h-10 px-1 text-xs'
          : 'min-h-14 px-3 text-base',
      )}
    >
      <span className="truncate">{item.label}</span>
    </button>
  );
}

function TodoPane({ section }: { section: Exclude<MobileTerminalSection, 'type' | 'keys'> }) {
  return (
    <div className="grid min-h-24 content-start gap-2 border-t border-border bg-app-bg px-4 py-3 text-foreground">
      {section === 'recent' ? (
        <>
          <h2 className="font-mono text-sm font-semibold">TODO: Recent commands</h2>
          <p className="text-sm text-muted">This pane will eventually show recently used commands.</p>
        </>
      ) : (
        <>
          <h2 className="font-mono text-sm font-semibold">TODO: Draft</h2>
          <p className="text-sm text-muted">This pane will eventually support composing text before sending it to the terminal.</p>
        </>
      )}
    </div>
  );
}

export function MobileTerminalUi({
  terminal,
  activeSection,
  defaultSection = 'type',
  onSectionChange,
  onSendInput,
  onFocusInput,
  interactive = true,
  fillViewport = false,
  className,
  terminalClassName,
  style,
}: MobileTerminalUiProps) {
  const [internalSection, setInternalSection] = useState<MobileTerminalSection>(defaultSection);
  const section = activeSection ?? internalSection;
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const [inputValue, setInputValue] = useState('');
  const viewportHeight = useVisualViewportHeight(fillViewport);

  const sendInput = useCallback((data: string) => {
    if (!interactive || data.length === 0) return;
    onSendInput?.(data);
  }, [interactive, onSendInput]);

  const focusInput = useCallback(() => {
    if (!interactive) return;
    onFocusInput?.();
    inputRef.current?.focus({ preventScroll: true });
  }, [interactive, onFocusInput]);

  const setSection = useCallback((nextSection: MobileTerminalSection) => {
    if (activeSection === undefined) setInternalSection(nextSection);
    onSectionChange?.(nextSection);
    if (nextSection === 'type') {
      window.requestAnimationFrame(focusInput);
    }
  }, [activeSection, focusInput, onSectionChange]);

  const flushInputValue = useCallback((value: string) => {
    if (value) sendInput(value);
    setInputValue('');
  }, [sendInput]);

  useEffect(() => {
    if (section !== 'type' || !interactive) return;
    const frame = window.requestAnimationFrame(focusInput);
    const delayedFocus = window.setTimeout(focusInput, 120);
    const settledFocus = window.setTimeout(focusInput, 500);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(delayedFocus);
      window.clearTimeout(settledFocus);
    };
  }, [focusInput, interactive, section]);

  const rootStyle: MobileTerminalStyle = { ...style };
  if (fillViewport && viewportHeight !== null) {
    rootStyle['--mobile-terminal-visible-height'] = `${viewportHeight}px`;
  }

  return (
    <div
      data-mobile-terminal-ui
      className={clsx(
        'relative flex min-h-0 flex-col overflow-hidden bg-app-bg text-app-fg',
        fillViewport ? 'h-[var(--mobile-terminal-visible-height,100dvh)]' : 'h-full',
        className,
      )}
      style={rootStyle}
    >
      <div
        className={clsx('min-h-0 flex-1 overflow-hidden bg-terminal-bg', terminalClassName)}
        onPointerDown={focusInput}
        onPointerUp={focusInput}
      >
        <div className="flex h-full min-h-0 flex-col">{terminal}</div>
      </div>

      {section === 'type' ? (
        <div className="grid shrink-0 grid-cols-7 gap-1 border-t border-border bg-app-bg px-2 py-2">
          {TERMINAL_KEYS.map((item) => (
            <KeyButton
              key={item.id}
              item={item}
              size="compact"
              disabled={!interactive}
              onPress={(id) => {
                sendInput(MOBILE_TERMINAL_KEY_SEQUENCES[id]);
                focusInput();
              }}
            />
          ))}
        </div>
      ) : null}

      {section === 'keys' ? (
        <div className="grid shrink-0 gap-2 border-t border-border bg-app-bg px-3 py-3">
          <div className="grid grid-cols-3 gap-2">
            {TERMINAL_KEYS.slice(0, 3).map((item) => (
              <KeyButton
                key={item.id}
                item={item}
                size="large"
                disabled={!interactive}
                onPress={(id) => sendInput(MOBILE_TERMINAL_KEY_SEQUENCES[id])}
              />
            ))}
          </div>
          <div className="grid grid-cols-4 gap-2">
            {TERMINAL_KEYS.slice(3).map((item) => (
              <KeyButton
                key={item.id}
                item={item}
                size="large"
                disabled={!interactive}
                onPress={(id) => sendInput(MOBILE_TERMINAL_KEY_SEQUENCES[id])}
              />
            ))}
          </div>
        </div>
      ) : null}

      {section === 'recent' || section === 'draft' ? <TodoPane section={section} /> : null}

      <nav className="grid h-12 shrink-0 grid-cols-4 border-t border-border bg-app-bg font-mono text-sm">
        {NAV_ITEMS.map((item) => {
          const selected = item.id === section;
          return (
            <button
              key={item.id}
              type="button"
              disabled={!interactive}
              aria-current={selected ? 'page' : undefined}
              onClick={() => setSection(item.id)}
              className={clsx(
                'min-w-0 border-t-2 px-1 transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring',
                'disabled:pointer-events-none',
                selected
                  ? 'border-focus-ring bg-header-active-bg text-header-active-fg'
                  : 'border-transparent text-muted hover:bg-header-inactive-bg hover:text-foreground',
              )}
            >
              <span className="truncate">{item.label}</span>
            </button>
          );
        })}
      </nav>

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
