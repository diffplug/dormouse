import { useSyncExternalStore } from 'react';
import { XIcon } from '@phosphor-icons/react';
import { modalIconButton } from './design';
import {
  getWatchedCommandsSnapshot,
  setCommandWatched,
  subscribeToWatchedCommands,
} from '../lib/terminal-registry';

/**
 * The app-global WATCHING rule set, with a remove control per rule
 * (`docs/specs/alert.md` -> WATCHING Track).
 *
 * Rendered by both the bell popover and the Alarm settings dialog — the two
 * places a rule set on a since-closed Pane can be found and removed. It is one
 * list shown twice, so it lives here rather than in either dialog.
 *
 * Rules are removable but not addable: WATCHING is keyed on a running command's
 * name, so creating one stays a bell click in the tab running it.
 */
export function WatchedCommandList() {
  const watched = useSyncExternalStore(subscribeToWatchedCommands, getWatchedCommandsSnapshot);
  if (watched.length === 0) return null;

  return (
    <ul className="flex flex-col gap-0.5">
      {watched.map((name) => (
        <li key={name} className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate font-mono text-sm text-foreground" title={name}>{name}</span>
          <button
            type="button"
            aria-label={`Stop alerting on all ${name}`}
            className={modalIconButton()}
            onClick={() => setCommandWatched(name, false)}
          >
            <XIcon size={12} weight="bold" />
          </button>
        </li>
      ))}
    </ul>
  );
}
