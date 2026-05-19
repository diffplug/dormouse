import { resolvePaneElement } from '../lib/spatial-nav';
import { ModalOverlay, ModalSurface, Shortcut } from './design';

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

export function KillConfirmCard({ char, onCancel, exit }: { char: string; onCancel?: () => void; exit?: KillExit }) {
  return (
    <ModalSurface
      role="dialog"
      aria-modal="true"
      aria-labelledby="kill-confirm-title"
      padding="spacious"
      align="center"
      className={exit === 'shake' ? 'motion-safe:animate-shake-x' : undefined}
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
        <button type="button" onClick={onCancel} className="contents group cursor-pointer">
          <Shortcut className="justify-self-end group-hover:text-foreground transition-colors">Esc</Shortcut>
          <span className="justify-self-start group-hover:text-foreground transition-colors">to cancel</span>
        </button>
      </div>
    </ModalSurface>
  );
}

export function KillConfirmOverlay({ confirmKill, paneElements, onCancel }: {
  confirmKill: ConfirmKill;
  paneElements: Map<string, HTMLElement>;
  onCancel: () => void;
}) {
  const panelEl = resolvePaneElement(paneElements.get(confirmKill.id));
  return (
    <ModalOverlay
      targetElement={panelEl}
      className={confirmKill.exit === 'confirm' ? 'kill-overlay-confirm' : undefined}
    >
      <KillConfirmCard char={confirmKill.char} onCancel={onCancel} exit={confirmKill.exit} />
    </ModalOverlay>
  );
}
