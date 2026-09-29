import { useState, useSyncExternalStore } from 'react';
import {
  endOneTime,
  getOneTimeSnapshot,
  subscribeToOneTime,
} from '../remote/burrow/one-time-store';

/**
 * "Phone connected · End" in the Baseboard's right cluster, while a one-time
 * connection has been allowed in (`docs/specs/one-time.md` -> "Laptop UI";
 * placement is `docs/specs/layout.md` -> "Baseboard").
 *
 * **Shown from `connecting` on**: the modal has been answered and the phone is
 * authorized, so the person at this machine can end it without reopening
 * Settings. Renders nothing otherwise, and nothing at all where there is no
 * Burrow service. The phone's own label is the tooltip only: the Baseboard's
 * room belongs to Doors. No phone glyph, which would read as the push button's
 * slashed phone beside it.
 */
export function OneTimeIndicator() {
  const store = useSyncExternalStore(subscribeToOneTime, getOneTimeSnapshot);
  const [ending, setEnding] = useState(false);

  if (store.kind !== 'ready') return null;
  const { state } = store;
  if (state.status !== 'connecting' && state.status !== 'connected') return null;

  const connected = state.status === 'connected';
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 pb-1 text-sm font-mono text-app-fg"
      title={`${state.label || '(unnamed)'} has full control of your terminals.`}
    >
      <span>{connected ? 'Phone connected' : 'Phone connecting…'}</span>
      <span aria-hidden className="text-muted">·</span>
      <button
        type="button"
        aria-label="End the one-time connection"
        disabled={ending}
        className="rounded text-link hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus-ring disabled:opacity-45"
        onClick={() => {
          setEnding(true);
          // The event that follows hides this; a refusal leaves it to try again.
          void endOneTime()
            .catch(() => {})
            .finally(() => setEnding(false));
        }}
      >
        End
      </button>
    </span>
  );
}
