import { useCallback, useEffect, useRef } from 'react';
import type { ModalLayer } from './design';
import { KillConfirmModal } from './KillConfirm';
import { acceptsKillChar } from './wall/keyboard/handle-kill-confirm';

/** One typed-letter interaction for Workspace close and move, window close, and
 *  app quit. */
export function WorkspaceKillConfirm({ char, onConfirm, onCancel, canConfirm, title = 'Confirm kill workspace', ...presentation }: {
  char: string;
  onConfirm: () => void;
  onCancel: () => void;
  canConfirm?: () => boolean;
  title?: string;
  targetElement?: HTMLElement | null;
  detail?: string;
  layer?: ModalLayer;
}) {
  // Callers pass fresh closures each render; both listeners read the latest ones
  // rather than re-binding on every re-render of their host. The frame's cancel
  // must stay stable too: ModalFrame re-binds on a new `onEscape`, which would
  // move its listener behind this one and let this one swallow Escape first.
  const latestRef = useRef({ onConfirm, onCancel, canConfirm });
  latestRef.current = { onConfirm, onCancel, canConfirm };
  const cancel = useCallback(() => latestRef.current.onCancel(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // ModalFrame handles Escape first on the same capture target.
      if (event.key === 'Escape' && event.defaultPrevented) return;
      // Cmd+Q is another quit request, never an answer even when the letter is q.
      if (event.metaKey || event.ctrlKey || event.altKey || ['Shift', 'Meta', 'Control', 'Alt'].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const latest = latestRef.current;
      if (latest.canConfirm && !latest.canConfirm()) return;
      if (acceptsKillChar(event.key, char)) latest.onConfirm();
      else latest.onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [char]);
  return <KillConfirmModal {...presentation} title={title} char={char} onCancel={cancel} />;
}
