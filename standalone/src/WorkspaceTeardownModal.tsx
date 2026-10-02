import { useCallback, useRef, useSyncExternalStore } from 'react';
// Standalone reaches into the lib source directly (same relative form as the
// sibling UpdateDebugModal.tsx). The terminal registry comes in via the
// `dormouse-lib` alias, matching quit.ts.
import { ModalFrame } from '../../lib/src/components/design';
import { WorkspaceKillConfirm } from '../../lib/src/components/WorkspaceKillConfirm';
import { subscribeToTerminalPaneState } from 'dormouse-lib/lib/terminal-registry';
import {
  cancelQuit,
  confirmQuit,
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
 * overlay. Mounted through Wall's
 * `dialogHost` slot. Command-mode suppression is the store's chrome keyboard
 * lease, held for every phase. Store-connected shell + presentational modal,
 * mirror of the ExternalLinkModalHost / ExternalLinkModal pair.
 */
export function WorkspaceTeardownModalHost() {
  const phase = useSyncExternalStore(subscribeQuitConfirm, getQuitConfirmPhase);
  const intent = useSyncExternalStore(subscribeQuitConfirm, getQuitConfirmIntent);

  if (!phase) return null;
  return (
    <WorkspaceTeardownModal
      char={getQuitConfirmChar()}
      workspaceNames={getQuitConfirmWorkspaceNames()}
      confirming={phase === 'quitting'}
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
  intent = { kind: 'quit' },
}: {
  confirming: boolean;
  char?: string;
  workspaceNames?: readonly string[];
  /** Whether this tears down the whole app or one window, and whether that
   *  discards a downloaded update. A quit and a restart read the same. */
  intent?: QuitConfirmIntent;
}) {
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
  const names = workspaceNames.join(', ');
  const scope = names ? `Workspaces: ${names}. ` : '';
  const count = hasRunning ? `${runningCount} running command${runningCount === 1 ? '' : 's'} will be stopped.` : 'No commands are still running.';
  const update = intent.discardsUpdate ? ' The downloaded update will be discarded.' : '';
  // A quit captures agent resumes; a window close ends its Sessions for good.
  const resume = intent.kind === 'quit' ? ' Supported agent sessions resume when Dormouse reopens.' : '';
  return <WorkspaceKillConfirm char={char} detail={`${scope}${count}${update}${resume}`} onConfirm={confirmQuit} onCancel={cancelQuit}
    layer="critical" />;
}
