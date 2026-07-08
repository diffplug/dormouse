import { useContext, useEffect, useRef, useSyncExternalStore } from 'react';
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
  getQuitConfirmPhase,
  subscribeQuitConfirm,
} from './quit-confirm-store';

/**
 * Quit-confirmation dialog (docs/specs/standalone.md §Quit flow, "Confirmation
 * dialog"). Mounted through Wall's `dialogHost` slot, which renders it beside
 * the built-in modal hosts inside Wall's `DialogKeyboardContext` provider; it
 * suppresses command-mode keyboard handling while visible. Store-connected
 * shell + presentational modal, mirror of the ExternalLinkModalHost /
 * ExternalLinkModal pair.
 */
export function QuitConfirmModalHost() {
  const phase = useSyncExternalStore(subscribeQuitConfirm, getQuitConfirmPhase);
  const setDialogKeyboardActive = useContext(DialogKeyboardContext);
  const open = phase !== null;

  // Suppress the Wall's command-mode key dispatch while the dialog is up.
  useEffect(() => {
    setDialogKeyboardActive(open);
    return () => setDialogKeyboardActive(false);
  }, [open, setDialogKeyboardActive]);

  if (!phase) return null;
  return <QuitConfirmModal confirming={phase === 'quitting'} />;
}

// Exported for Storybook (QuitConfirmModal.stories.tsx), which renders the
// presentational modal directly — same split as ExternalLinkModal's stories.
export function QuitConfirmModal({ confirming }: { confirming: boolean }) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  // Live count — the dialog stays open even if it drops to 0 (see spec).
  const runningCount = useSyncExternalStore(subscribeToTerminalPaneState, countRunningSessions);
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
      <h2 id="quit-confirm-modal-title" className="text-sm leading-5 text-foreground">
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
          onClick={confirmQuit}
          disabled={confirming}
          className={`${modalActionButton({ tone: 'primary' })} min-w-[5rem]`}
        >
          {hasRunning ? `Quit and stop ${runningCount}` : 'Quit'}
        </button>
      </div>
    </ModalFrame>
  );
}
