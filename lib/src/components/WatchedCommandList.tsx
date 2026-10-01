import { useSyncExternalStore } from 'react';
import { XIcon } from '@phosphor-icons/react';
import { modalIconButton } from './design';
import {
  getWatchedCommandsSnapshot,
  setCommandWatched,
  subscribeToWatchedCommands,
} from '../lib/terminal-registry';

/** The app-global WATCHING rule set with a remove control per rule; rules are
 *  created elsewhere (`docs/specs/alert.md` -> Settings dialog). */
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
            aria-label={`Remove ${name} rule`}
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
