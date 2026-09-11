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
  getQuitConfirmIntent,
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
export function QuitConfirmModalHost() {
  const phase = useSyncExternalStore(subscribeQuitConfirm, getQuitConfirmPhase);
  const storedArchiveError = useSyncExternalStore(subscribeQuitConfirm, getQuitArchiveError);
  const intent = useSyncExternalStore(subscribeQuitConfirm, getQuitConfirmIntent);
  const open = phase !== null;

  // Suppress the Wall's command-mode key dispatch while the dialog is up.
  useDialogKeyboardOwner(open);

  if (!phase) return null;
  return (
    <QuitConfirmModal
      confirming={phase === 'quitting'}
      archiveError={phase === 'archive-failed' ? storedArchiveError : null}
      intent={intent}
    />
  );
}

// Exported for Storybook (QuitConfirmModal.stories.tsx), which renders the
// presentational modal directly — same split as ExternalLinkModal's stories.
export function QuitConfirmModal({
  confirming,
  archiveError = null,
  intent = { kind: 'quit' },
}: {
  confirming: boolean;
  /** The teardown the notepad archive refused (docs/specs/notepad.md →
   *  "Standalone quit"). Set means the running-command decision is already made
   *  and this dialog now asks only whether to lose the notes. */
  archiveError?: string | null;
  /** Whether this asks about the whole app or one window, and which one. */
  intent?: QuitConfirmIntent;
}) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  // Live count — the dialog stays open even if it drops to 0 (see spec).
  const runningCount = useSyncExternalStore(subscribeToTerminalPaneState, countRunningSessions);
  const hasRunning = runningCount > 0;

  // Two dialogs in one frame. An archive error means the running-command
  // decision is already made and the only question left is whether to lose the
  // notes — so the copy changes and the default swaps to Cancel, stated once
  // here rather than as five ternaries through the markup.
  // A quit ends every window; a close ends this one alone. The count and the
  // notes are this window's either way — the registry and the notepad store are
  // per webview — so only the wording changes.
  const closing = intent.kind === 'close-window';
  const verb = closing ? 'Close' : 'Quit';
  // Named only when several windows are open, so a lone window's dialog is not
  // made to introduce itself.
  const scope = intent.windowName ? `${intent.windowName}: ` : '';
  const title = archiveError
    ? 'Notes could not be archived'
    : closing ? 'Close this window?' : 'Quit Dormouse?';
  const body = archiveError
    ? `${archiveError} ${verb === 'Close' ? 'Closing' : 'Quitting'} anyway discards them.`
    : confirming
      ? `${closing ? 'Closing' : 'Quitting'}…`
      : hasRunning
        ? `${scope}${runningCount} running command${runningCount === 1 ? '' : 's'} will be stopped.`
        : `${scope}No commands are still running.`;
  // The download lives in this webview, so closing the window throws it away and
  // the app installs nothing on the next quit (docs/specs/auto-update.md).
  const updateNotice = !archiveError && !confirming && intent.discardsUpdate
    ? 'The downloaded update will be discarded.'
    : null;
  const confirmLabel = archiveError
    ? `${verb} anyway`
    : hasRunning ? `${verb} and stop ${runningCount}` : verb;
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
      {updateNotice && <p className="mt-1 text-sm text-muted">{updateNotice}</p>}

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
