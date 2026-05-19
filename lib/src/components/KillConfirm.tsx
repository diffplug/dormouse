import { useRef } from 'react';
import { resolvePaneElement } from '../lib/spatial-nav';
import { ModalFrame, Shortcut } from './design';

export type KillExit = 'shake' | 'confirm';

export interface ConfirmKill {
  id: string;
  char: string;
  exit?: KillExit;
}

export const KILL_SHAKE_MS = 400;
export const KILL_CONFIRM_MS = 220;

// Excludes 'x' so the kill shortcut can't accept itself on a double-tap.
const KILL_CONFIRM_CHARS = 'abcdefghijklmnopqrstuvwyz';
export function randomKillChar(): string {
  return KILL_CONFIRM_CHARS[Math.floor(Math.random() * KILL_CONFIRM_CHARS.length)];
}

export function KillConfirmModal({
  char,
  onCancel,
  exit,
  targetElement,
}: {
  char: string;
  onCancel?: () => void;
  exit?: KillExit;
  targetElement?: HTMLElement | null;
}) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <ModalFrame
      titleId="kill-confirm-title"
      targetElement={targetElement}
      padding="spacious"
      align="center"
      className={exit === 'shake' ? 'motion-safe:animate-shake-x' : undefined}
      overlayClassName={exit === 'confirm' ? 'kill-overlay-confirm' : undefined}
      initialFocusRef={cancelButtonRef}
      onEscape={onCancel}
    >
      <h2 id="kill-confirm-title" className="text-base font-bold mb-3 text-foreground">
        Confirm kill
      </h2>
      <div className="bg-app-bg py-2 px-6 rounded border border-border inline-block mb-2">
        <span
          className={`text-xl font-bold${exit === 'confirm' ? ' kill-letter-flash' : ''}`}
          style={{ color: 'var(--color-error)' }}
        >
          {char}
        </span>
      </div>
      <div className="text-sm text-muted leading-relaxed grid grid-cols-[auto_auto] gap-x-2 justify-center">
        <Shortcut className="justify-self-end">{char}</Shortcut>
        <span className="justify-self-start">to confirm</span>
        <button
          ref={cancelButtonRef}
          type="button"
          onClick={onCancel}
          className="contents group cursor-pointer"
        >
          <Shortcut className="justify-self-end group-hover:text-foreground transition-colors">Esc</Shortcut>
          <span className="justify-self-start group-hover:text-foreground transition-colors">to cancel</span>
        </button>
      </div>
    </ModalFrame>
  );
}

export function KillConfirmOverlay({ confirmKill, paneElements, onCancel }: {
  confirmKill: ConfirmKill;
  paneElements: Map<string, HTMLElement>;
  onCancel: () => void;
}) {
  const panelEl = resolvePaneElement(paneElements.get(confirmKill.id));
  return (
    <KillConfirmModal
      char={confirmKill.char}
      onCancel={onCancel}
      exit={confirmKill.exit}
      targetElement={panelEl}
    />
  );
}
