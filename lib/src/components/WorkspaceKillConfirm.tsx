import { useEffect } from 'react';
import type { ModalLayer } from './design';
import { KillConfirmModal } from './KillConfirm';
import { acceptsKillChar } from './wall/keyboard/handle-kill-confirm';

/** One typed-letter interaction for Workspace, window, and app termination. */
export function WorkspaceKillConfirm({ char, onConfirm, onCancel, canConfirm, ...presentation }: {
  char: string;
  onConfirm: () => void;
  onCancel: () => void;
  canConfirm?: () => boolean;
  targetElement?: HTMLElement | null;
  detail?: string;
  layer?: ModalLayer;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // ModalFrame handles Escape first on the same capture target.
      if (event.key === 'Escape' && event.defaultPrevented) return;
      // Cmd+Q is another quit request, never an answer even when the letter is q.
      if (event.metaKey || event.ctrlKey || event.altKey || ['Shift', 'Meta', 'Control', 'Alt'].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (canConfirm && !canConfirm()) return;
      if (acceptsKillChar(event.key, char)) onConfirm();
      else onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [char, onConfirm, onCancel, canConfirm]);
  return <KillConfirmModal {...presentation} title="Confirm kill workspace" char={char} onCancel={onCancel} />;
}
