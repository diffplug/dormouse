import { useRef } from 'react';
import { ModalFrame, Shortcut } from './design';

/** How the prompt names the key that raised it. */
export function strayKeyLabel(key: string): string {
  return key === ' ' ? 'Space' : key;
}

/** The bare command-mode keys, as the prompt lists them, space-separated.
 *  Every key here is dispatched by the command-mode chain, so none of them
 *  raises this prompt (pinned in `wall/keyboard/handle-stray-key.test.ts`). */
export const COMMAND_KEYS: ReadonlyArray<readonly [keys: string, label: string]> = [
  ['Enter', 'type'],
  ['↑ ↓ ← →', 'move'],
  ['| %', 'split right'],
  ['- "', 'split down'],
  ['z', 'zoom'],
  ['m d', 'minimize'],
  ['k x', 'kill'],
  ['u', 'reopen'],
  [',', 'rename'],
  ['t', 'TODO'],
  ['a', 'alert'],
  ['>', 'context'],
];

/** Bound only on a Wall with Workspaces; a bare Wall's digits are strays. */
export const WORKSPACE_KEYS = ['1–9', 'Workspace'] as const;

/** Raised by a key that is not a command-mode shortcut: someone typing into a
 *  terminal they thought was in passthrough. */
export function StrayKeyModal({
  strayKey,
  workspaces,
  targetElement,
  onCancel,
}: {
  strayKey: string;
  /** Whether this Wall binds the Workspace digits. */
  workspaces: boolean;
  targetElement?: HTMLElement | null;
  onCancel?: () => void;
}) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const keys = workspaces ? [...COMMAND_KEYS, WORKSPACE_KEYS] : COMMAND_KEYS;
  return (
    <ModalFrame
      titleId="stray-key-title"
      targetElement={targetElement}
      padding="spacious"
      align="center"
      initialFocusRef={cancelButtonRef}
      onEscape={onCancel}
      onOutsideClick={onCancel}
      data-stray-key-prompt=""
    >
      <h2 id="stray-key-title" className="text-base font-bold mb-3 text-foreground">
        That&apos;s not a shortcut
      </h2>
      <p className="text-sm text-muted mb-3 max-w-xs">
        <span className="font-mono text-foreground">{strayKeyLabel(strayKey)}</span> does nothing in command mode.
      </p>
      <div className="text-sm text-muted leading-relaxed grid grid-cols-[auto_auto] gap-x-2 justify-center mb-3">
        <Shortcut className="justify-self-end">Enter</Shortcut>
        <span className="justify-self-start">to type into the terminal</span>
        <button
          ref={cancelButtonRef}
          type="button"
          onClick={onCancel}
          className="contents group cursor-pointer"
        >
          <Shortcut className="justify-self-end group-hover:text-foreground transition-colors">Esc</Shortcut>
          <span className="justify-self-start group-hover:text-foreground transition-colors">to stay in command mode</span>
        </button>
      </div>
      <div className="text-xs text-muted grid grid-cols-[auto_auto_auto_auto] gap-x-2 justify-center">
        {keys.map(([key, label]) => (
          <span key={key} className="contents">
            <span className="justify-self-end font-mono text-foreground">{key}</span>
            <span className="justify-self-start">{label}</span>
          </span>
        ))}
      </div>
    </ModalFrame>
  );
}
