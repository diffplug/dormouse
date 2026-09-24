import { useCallback, useRef, useSyncExternalStore } from 'react';
// Standalone reaches into the lib source directly (same relative form as the
// sibling UpdateDebugModal.tsx). The terminal registry comes in via the
// `dormouse-lib` alias, matching quit.ts.
import { ModalFrame, modalActionButton } from '../../lib/src/components/design';
import { WorkspaceKillConfirm } from '../../lib/src/components/WorkspaceKillConfirm';
import { subscribeToTerminalPaneState } from 'dormouse-lib/lib/terminal-registry';
import {
  cancelQuit,
  confirmQuit,
  getQuitArchiveError,
  getQuitConfirmIntent,
  getQuitConfirmChar,
  getQuitConfirmWorkspaceNames,
  getQuitConfirmPhase,
  quitRunningWork,
  subscribeQuitConfirm,
  type QuitConfirmIntent,
} from './quit-confirm-store';

/**
 * The window-close and quit teardown dialog (docs/specs/standalone.md §Quit
 * flow, "Confirmation dialog"): the typed-letter confirmation, the progress
 * overlay, and the archive-failure decision. Mounted through Wall's
 * `dialogHost` slot. Command-mode suppression is the store's chrome keyboard
 * lease, held for every phase. Store-connected shell + presentational modal,
 * mirror of the ExternalLinkModalHost / ExternalLinkModal pair.
 */
export function WorkspaceTeardownModalHost() {
  const phase = useSyncExternalStore(subscribeQuitConfirm, getQuitConfirmPhase);
  const storedArchiveError = useSyncExternalStore(subscribeQuitConfirm, getQuitArchiveError);
  const intent = useSyncExternalStore(subscribeQuitConfirm, getQuitConfirmIntent);

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
  /** Whether this tears down the whole app or one window, and whether that
   *  discards a downloaded update. A quit and a restart read the same. */
  intent?: QuitConfirmIntent;
}) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const progressRef = useRef<HTMLParagraphElement>(null);
  // Live count — the dialog stays open even if it drops to 0 (see spec).
  const { requester } = intent;
  const getRunningCount = useCallback(() => quitRunningWork({ requester }), [requester]);
  const runningCount = useSyncExternalStore(subscribeToTerminalPaneState, getRunningCount);
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
    const names = workspaceNames.join(', ');
    const scope = names ? `Workspaces: ${names}. ` : '';
    const count = hasRunning ? `${runningCount} running command${runningCount === 1 ? '' : 's'} will be stopped.` : 'No commands are still running.';
    const update = intent.discardsUpdate ? ' The downloaded update will be discarded.' : '';
    // A quit captures agent resumes; a window close ends its Sessions for good.
    const resume = intent.kind === 'quit' ? ' Supported agent sessions resume when Dormouse reopens.' : '';
    return <WorkspaceKillConfirm char={char} detail={`${scope}${count}${update}${resume}`} onConfirm={confirmQuit} onCancel={cancelQuit}
      layer="critical" />;
  }
  // Note loss needs its own decision even after process termination was approved.
  return (
    <ModalFrame
      titleId="quit-confirm-modal-title"
      layer="critical"
      backdrop="strong"
      elevation="modal"
      overlayClassName="px-4 py-6"
      className="w-full max-w-[26rem]"
      initialFocusRef={cancelButtonRef}
      onEscape={cancelQuit}
    >
      <h2 id="quit-confirm-modal-title" className="text-sm leading-5 text-foreground">Notes could not be archived</h2>
      <p className="mt-2 text-sm text-muted">{archiveError} Continuing discards them.</p>

      <div className="mt-4 flex justify-end gap-2">
        <button
          ref={cancelButtonRef}
          type="button"
          onClick={cancelQuit}
          className={`${modalActionButton({ tone: 'primary' })} min-w-[5rem]`}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={confirmQuit}
          className={`${modalActionButton({ tone: 'secondary' })} min-w-[5rem]`}
        >
          Discard notes and continue
        </button>
      </div>
    </ModalFrame>
  );
}
