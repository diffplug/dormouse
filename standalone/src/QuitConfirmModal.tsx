import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
// Standalone reaches into the lib source directly (same relative form as the
// sibling UpdateDebugModal.tsx). The terminal registry comes in via the
// `dormouse-lib` alias, matching quit.ts.
import { ModalFrame, modalActionButton } from '../../lib/src/components/design';
import { DialogKeyboardContext } from '../../lib/src/components/wall/wall-context';
import {
  countRunningSessions,
  subscribeToTerminalPaneState,
} from 'dormouse-lib/lib/terminal-registry';
import {
  cancelQuit,
  confirmQuit,
  getQuitConfirmSnapshot,
  subscribeQuitConfirm,
} from './quit-confirm-store';

/**
 * Quit-confirmation dialog (docs/specs/standalone.md §Quit flow, "Confirmation
 * dialog"). Mounted in the `baseboardNotice` slot so it lives inside Wall's
 * `DialogKeyboardContext` provider; it suppresses command-mode keyboard
 * handling while visible. Store-connected shell + presentational modal, mirror
 * of the ExternalLinkModalHost / ExternalLinkModal pair.
 */
export function QuitConfirmModalHost() {
  const snapshot = useSyncExternalStore(subscribeQuitConfirm, getQuitConfirmSnapshot);
  const setDialogKeyboardActive = useContext(DialogKeyboardContext);
  const open = snapshot !== null;

  // Suppress the Wall's command-mode key dispatch while the dialog is up.
  useEffect(() => {
    setDialogKeyboardActive(open);
    return () => setDialogKeyboardActive(false);
  }, [open, setDialogKeyboardActive]);

  if (!snapshot) return null;
  return <QuitConfirmModal />;
}

function QuitConfirmModal() {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  // After confirm the teardown is running and the app exits within ~1–3s; the
  // dialog stays up in a non-interactive "Quitting…" state (buttons disabled)
  // so a second confirm / an Escape can't fire.
  const [confirming, setConfirming] = useState(false);
  // Live count: a command may finish while the dialog is open. If it drops to 0
  // the dialog stays open (auto-quitting under the user would surprise) — the
  // copy just reflects the current number.
  const runningCount = useSyncExternalStore(subscribeToTerminalPaneState, countRunningSessions);

  const handleConfirm = () => {
    if (confirming) return;
    setConfirming(true);
    confirmQuit();
  };

  const hasRunning = runningCount > 0;

  return (
    <ModalFrame
      titleId="quit-confirm-modal-title"
      layer="critical"
      backdrop="strong"
      elevation="modal"
      overlayClassName="px-4 py-6"
      className="w-full max-w-[26rem]"
      initialFocusRef={cancelButtonRef}
      onEscape={confirming ? undefined : cancelQuit}
    >
      <h2 id="quit-confirm-modal-title" className="text-sm font-medium text-foreground">
        Quit Dormouse?
      </h2>
      <p className="mt-2 text-sm text-muted">
        {confirming
          ? 'Quitting…'
          : hasRunning
            ? `${runningCount} running command${runningCount === 1 ? '' : 's'} will be stopped.`
            : 'No commands are still running.'}
      </p>

      <div className="mt-4 flex justify-end gap-2">
        <button
          ref={cancelButtonRef}
          type="button"
          onClick={cancelQuit}
          disabled={confirming}
          className={`${modalActionButton({ tone: 'secondary' })} min-w-[5rem]`}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={confirming}
          className={`${modalActionButton({ tone: 'primary' })} min-w-[5rem]`}
        >
          {hasRunning ? `Quit and stop ${runningCount}` : 'Quit'}
        </button>
      </div>
    </ModalFrame>
  );
}
