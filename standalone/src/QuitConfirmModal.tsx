import { useRef, useSyncExternalStore } from 'react';
// Standalone reaches into the lib source directly (same relative form as the
// sibling UpdateDebugModal.tsx). The terminal registry comes in via the
// `dormouse-lib` alias, matching quit.ts.
import { ModalFrame, modalActionButton } from '../../lib/src/components/design';
import { useDialogKeyboardOwner } from '../../lib/src/components/wall/wall-context';
import {
  countRunningSessions,
  subscribeToTerminalPaneState,
} from 'dormouse-lib/lib/terminal-registry';
import {
  cancelQuit,
  confirmQuit,
  getQuitArchiveError,
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
  const storedArchiveError = useSyncExternalStore(subscribeQuitConfirm, getQuitArchiveError);
  const open = phase !== null;

  // Suppress the Wall's command-mode key dispatch while the dialog is up.
  useDialogKeyboardOwner(open);

  if (!phase) return null;
  return (
    <QuitConfirmModal
      confirming={phase === 'quitting'}
      archiveError={phase === 'archive-failed' ? storedArchiveError : null}
    />
  );
}

// Exported for Storybook (QuitConfirmModal.stories.tsx), which renders the
// presentational modal directly — same split as ExternalLinkModal's stories.
export function QuitConfirmModal({
  confirming,
  archiveError = null,
}: {
  confirming: boolean;
  /** The quit the notepad archive refused (docs/specs/notepad.md → "Standalone
   *  quit"). Set means the running-command decision is already made and this
   *  dialog now asks only whether to lose the notes. */
  archiveError?: string | null;
}) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  // Live count — the dialog stays open even if it drops to 0 (see spec).
  const runningCount = useSyncExternalStore(subscribeToTerminalPaneState, countRunningSessions);
  const hasRunning = runningCount > 0;

  // Two dialogs in one frame. An archive error means the running-command
  // decision is already made and the only question left is whether to lose the
  // notes — so the copy changes and the default swaps to Cancel, stated once
  // here rather than as five ternaries through the markup.
  const title = archiveError ? 'Notes could not be archived' : 'Quit Dormouse?';
  const body = archiveError
    ? `${archiveError} Quitting anyway discards them.`
    : confirming
      ? 'Quitting…'
      : hasRunning
        ? `${runningCount} running command${runningCount === 1 ? '' : 's'} will be stopped.`
        : 'No commands are still running.';
  const confirmLabel = archiveError
    ? 'Quit anyway'
    : hasRunning ? `Quit and stop ${runningCount}` : 'Quit';
  const [cancelTone, confirmTone] = archiveError
    ? (['primary', 'secondary'] as const)
    : (['secondary', 'primary'] as const);

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
      <h2 id="quit-confirm-modal-title" className="text-sm leading-5 text-foreground">{title}</h2>
      <p className="mt-2 text-sm text-muted">{body}</p>

      <div className="mt-4 flex justify-end gap-2">
        <button
          ref={cancelButtonRef}
          type="button"
          onClick={cancelQuit}
          disabled={confirming}
          className={`${modalActionButton({ tone: cancelTone })} min-w-[5rem]`}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={confirmQuit}
          disabled={confirming}
          className={`${modalActionButton({ tone: confirmTone })} min-w-[5rem]`}
        >
          {confirmLabel}
        </button>
      </div>
    </ModalFrame>
  );
}
