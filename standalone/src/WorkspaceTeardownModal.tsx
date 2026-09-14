import { useRef, useSyncExternalStore } from 'react';
// Standalone reaches into the lib source directly (same relative form as the
// sibling UpdateDebugModal.tsx). The terminal registry comes in via the
// `dormouse-lib` alias, matching quit.ts.
import { ModalFrame, modalActionButton } from '../../lib/src/components/design';
import { WorkspaceKillConfirm } from '../../lib/src/components/WorkspaceKillConfirm';
import { useDialogKeyboardOwner } from '../../lib/src/components/wall/wall-context';
import {
  countRunningSessions,
  subscribeToTerminalPaneState,
} from 'dormouse-lib/lib/terminal-registry';
import {
  cancelQuit,
  confirmQuit,
  getQuitArchiveError,
  getQuitConfirmIntent,
  getQuitConfirmChar,
  getQuitConfirmWorkspaceNames,
  getQuitConfirmPhase,
  subscribeQuitConfirm,
  type QuitConfirmIntent,
} from './quit-confirm-store';

/**
 * Quit-confirmation dialog (docs/specs/standalone.md §Quit flow, "Confirmation
 * dialog"). Mounted through Wall's `dialogHost` slot, which renders it beside
 * the built-in modal hosts inside Wall's `DialogKeyboardContext` provider; it
 * suppresses command-mode keyboard handling while visible. Store-connected
 * shell + presentational modal, mirror of the ExternalLinkModalHost /
 * ExternalLinkModal pair.
 */
export function WorkspaceTeardownModalHost() {
  const phase = useSyncExternalStore(subscribeQuitConfirm, getQuitConfirmPhase);
  const storedArchiveError = useSyncExternalStore(subscribeQuitConfirm, getQuitArchiveError);
  const intent = useSyncExternalStore(subscribeQuitConfirm, getQuitConfirmIntent);
  const open = phase !== null;

  // Suppress the Wall's command-mode key dispatch while the dialog is up.
  useDialogKeyboardOwner(open);

  if (!phase) return null;
  return (
    <WorkspaceTeardownModal
      char={getQuitConfirmChar()}
      workspaceNames={getQuitConfirmWorkspaceNames()}
      confirming={phase === 'quitting'}
      archiveError={phase === 'archive-failed' ? storedArchiveError : null}
      intent={intent}
    />
  );
}

// Exported for Storybook (WorkspaceTeardownModal.stories.tsx), which renders the
// presentational modal directly — same split as ExternalLinkModal's stories.
export function WorkspaceTeardownModal({
  confirming,
  char = 'q',
  workspaceNames = [],
  archiveError = null,
  intent = { kind: 'quit' },
}: {
  confirming: boolean;
  char?: string;
  workspaceNames?: readonly string[];
  /** The teardown the notepad archive refused (docs/specs/notepad.md →
   *  "Standalone quit"). Set means the running-command decision is already made
   *  and this dialog now asks only whether to lose the notes. */
  archiveError?: string | null;
  /** Whether this asks about the whole app or one window, and which one. */
  intent?: QuitConfirmIntent;
}) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const progressRef = useRef<HTMLParagraphElement>(null);
  // Live count — the dialog stays open even if it drops to 0 (see spec).
  const runningCount = useSyncExternalStore(subscribeToTerminalPaneState, countRunningSessions);
  const hasRunning = runningCount > 0;

  if (confirming) {
    return (
      <ModalFrame titleId="workspace-kill-progress-title" layer="critical" padding="spacious" align="center" initialFocusRef={progressRef}>
        <h2 id="workspace-kill-progress-title" className="text-base font-bold mb-3 text-foreground">Confirm kill workspace</h2>
        <p ref={progressRef} tabIndex={-1} role="status" className="text-sm text-muted">
          {intent.kind === 'quit' ? 'Waiting for all windows, then closing…' : 'Closing workspaces…'}
        </p>
      </ModalFrame>
    );
  }
  if (!archiveError) {
    const names = workspaceNames.length ? workspaceNames.join(', ') : intent.windowName;
    const scope = names ? `Workspaces: ${names}. ` : '';
    const count = hasRunning ? `${runningCount} running command${runningCount === 1 ? '' : 's'} will be stopped.` : 'No commands are still running.';
    const update = intent.discardsUpdate ? ' The downloaded update will be discarded.' : '';
    return <WorkspaceKillConfirm char={char} detail={`${scope}${count}${update}`} onConfirm={confirmQuit} onCancel={cancelQuit}
      layer="critical" />;
  }
  // Note loss needs its own decision even after process termination was approved.
  const title = 'Notes could not be archived';
  const body = `${archiveError} Continuing discards them.`;
  const confirmLabel = 'Discard notes and continue';
  const cancelTone = 'primary';
  const confirmTone = 'secondary';
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
