import { useCallback, useContext, useSyncExternalStore } from 'react';
import { PopupButtonRow, popupButton } from '../design';
import { resumeCommandLabel } from '../../lib/resume-patterns';
import {
  clearResumeOffer,
  getResumeOfferSnapshot,
  subscribeToResumeOffers,
} from '../../lib/resume-offers';
import {
  getTerminalPaneStateSnapshot,
  runResumeCommand,
  subscribeToTerminalPaneState,
} from '../../lib/terminal-registry';
import { WallActionsContext } from './wall-context';

export interface ResumeBannerViewProps {
  /** The resume command detected in the restored scrollback
   *  (`lib/src/lib/resume-patterns.ts`). */
  command: string;
  /** Run the command in this pane's fresh shell. */
  onResume: () => void;
  /** Drop the offer for this pane. */
  onDismiss: () => void;
}

/**
 * The offer a cold-restored terminal pane makes: its saved scrollback ended in
 * an agent's resume hint, but the process behind it is gone and the pane now
 * holds a fresh shell. One click puts the agent session back.
 *
 * Two buttons, no prose. The run button is labelled with the invocation only
 * (`Run claude --resume`) — the session id it will pass sits in the replayed
 * scrollback directly above, so restating it would just crowd the button.
 *
 * Sits bottom-right — the opposite corner from `MouseOverrideBanner`, so the two
 * never collide, and clear of the left-aligned prompt it is offering to type into.
 * Same `PopupButtonRow` vocabulary as that sibling: one raised surface owning the
 * border, background, and shadow, with the run action carrying the accent tone.
 */
export function ResumeBannerView({ command, onResume, onDismiss }: ResumeBannerViewProps) {
  return (
    <PopupButtonRow
      className="absolute right-1 bottom-1 z-20 whitespace-nowrap"
      // The terminal owns mouse events inside the pane; keep the offer's own
      // clicks from starting a selection drag underneath it.
      onMouseDown={(e) => e.stopPropagation()}
      role="status"
    >
      <button
        type="button"
        // The full command with its id is the tooltip: available on demand,
        // never occupying chrome.
        title={command}
        className={popupButton({ tone: 'primary' })}
        onClick={onResume}
      >Run {resumeCommandLabel(command)}</button>
      <button
        type="button"
        className={popupButton({ tone: 'muted' })}
        onClick={onDismiss}
      >Dismiss</button>
    </PopupButtonRow>
  );
}

/**
 * The pane-mounted offer. Renders nothing unless this Session was cold-restored
 * with a resume command still pending (`lib/src/lib/resume-offers.ts`).
 *
 * Hidden while a command is running: the offer types into the shell, and a shell
 * with a foreground process is not listening. Sessions whose shell has no OSC
 * integration report `unknown` activity and keep the offer — the pane still
 * retires it on the user's first keystroke.
 */
export function ResumeBanner({ terminalId }: { terminalId: string }) {
  const actions = useContext(WallActionsContext);
  const offers = useSyncExternalStore(subscribeToResumeOffers, getResumeOfferSnapshot);
  // Selects the one enum this gate needs rather than the whole pane-state map:
  // that store hands out a new snapshot identity on every semantic event, and
  // this component is mounted in every pane, so subscribing to the map would
  // re-render all of them on every title/prompt/cwd event to render nothing.
  const activityKind = useSyncExternalStore(
    subscribeToTerminalPaneState,
    useCallback(() => getTerminalPaneStateSnapshot().get(terminalId)?.activity.kind, [terminalId]),
  );
  const command = offers.get(terminalId);
  if (!command) return null;
  if (activityKind === 'running') return null;

  return (
    <ResumeBannerView
      command={command}
      onResume={() => {
        // The banner stops its mousedown from reaching TerminalPanel so the
        // terminal cannot begin a selection underneath it. Reproduce the pane
        // click transition explicitly before the button unmounts: this selects
        // the pane, enters passthrough, and defers xterm focus until after click.
        actions.onClickPanel(terminalId);
        runResumeCommand(terminalId, command);
      }}
      onDismiss={() => clearResumeOffer(terminalId)}
    />
  );
}
