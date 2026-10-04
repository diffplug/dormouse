import { useRef } from 'react';
import { resolvePaneElement } from './wall/resolve-pane-element';
import { ModalFrame, Shortcut, type ModalLayer } from './design';
import { cfg } from '../cfg';

export type KillExit = 'shake' | 'confirm';

export interface ConfirmKill {
  id: string;
  char: string;
  exit?: KillExit;
  /** What the letter confirms: a kill, or a Tool's Break
   *  (`docs/specs/dor-tool.md` -> Run end), which the same gate guards. */
  action?: 'kill' | 'break';
  /** A Break's Tool had a page to reopen beside its terminal. */
  serving?: boolean;
}

export const KILL_SHAKE_MS = 400;
export const KILL_CONFIRM_MS = 220;

// Excludes both kill shortcuts ('x' and 'k') so a double-tap can't accept itself,
// and Reopen's 'u', so reaching to undo an earlier close never confirms this one.
const KILL_CONFIRM_CHARS = 'abcdefghijlmnopqrstvwyz';
export function randomKillChar(): string {
  return cfg.killConfirm.char ?? KILL_CONFIRM_CHARS[Math.floor(Math.random() * KILL_CONFIRM_CHARS.length)];
}

export function KillConfirmModal({
  char,
  onCancel,
  exit,
  targetElement,
  title = 'Confirm kill',
  detail,
  cancelHint,
  layer,
}: {
  char: string;
  onCancel?: () => void;
  exit?: KillExit;
  targetElement?: HTMLElement | null;
  /** The same typed-letter gate stands in front of other destructive steps
   *  (a Workspace move that loses iframe page state); they name themselves. */
  title?: string;
  detail?: string;
  cancelHint?: string;
  layer?: ModalLayer;
}) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <ModalFrame
      titleId="kill-confirm-title"
      layer={layer}
      targetElement={targetElement}
      padding="spacious"
      align="center"
      className={exit === 'shake' ? 'motion-safe:animate-shake-x' : undefined}
      overlayClassName={exit === 'confirm' ? 'kill-overlay-confirm' : undefined}
      initialFocusRef={cancelButtonRef}
      onEscape={onCancel}
    >
      <h2 id="kill-confirm-title" className="text-base font-bold mb-3 text-foreground">
        {title}
      </h2>
      {detail && <p className="text-sm text-muted mb-3 max-w-xs">{detail}</p>}
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
          <span className="justify-self-start group-hover:text-foreground transition-colors">{cancelHint ?? 'to cancel'}</span>
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
  // Center over the whole pane (the leaf div: header + content).
  const panelEl = resolvePaneElement(paneElements.get(confirmKill.id));
  return (
    <KillConfirmModal
      char={confirmKill.char}
      onCancel={onCancel}
      exit={confirmKill.exit}
      targetElement={panelEl}
      {...(confirmKill.action === 'break' ? {
        title: 'Confirm break',
        detail: confirmKill.serving
          ? 'This Tool becomes a plain terminal, still running; its page opens in a browser pane beside it. They cannot be rejoined.'
          : 'This Tool becomes a plain terminal, still running. It cannot become a Tool again.',
      } : {})}
    />
  );
}
