/**
 * The one-time connection's state, as an external store the Settings panel and
 * the Baseboard indicator both read (`docs/specs/one-time.md` -> "Laptop UI").
 *
 * Like `burrow-status-store.ts`, it holds nothing but a mirror: the runtime, its
 * socket, and its session live in the Burrow service, one round trip away. It
 * is in the main chunk for the same reason that store is — the Settings dialog
 * and the Baseboard are — so everything it takes from the Burrow side is a type,
 * except the one guard the untrusted edge needs.
 *
 * **The `one-time` event is the authority.** The service sends the complete
 * state on every change (`service-protocol.ts` -> `OneTimeEvent`), so the store
 * replaces rather than merges, and reads `oneTimeStatus` only to seed a first
 * subscriber, to re-seed a panel that opens, and after `oneTimeEnd`.
 */

import { isOneTimeState, type OneTimeEvent } from '../../host/remote/service-protocol';
import { burrowLink, describeBurrowError, requireBurrowLink } from './burrow-status-store';
import type { OneTimeState } from './one-time-runtime';

/**
 * `unsupported` is a build with no Burrow service behind it — the section above
 * the panel renders nothing there, and the indicator never shows. `error` means
 * there is a service and a read failed with no state the store may keep.
 */
export type OneTimeStoreState =
  | { kind: 'unsupported' }
  | { kind: 'loading' }
  | { kind: 'ready'; state: OneTimeState }
  | { kind: 'error'; message: string };

const UNSUPPORTED: OneTimeStoreState = { kind: 'unsupported' };
const LOADING: OneTimeStoreState = { kind: 'loading' };

let snapshot: OneTimeStoreState = LOADING;
const listeners = new Set<() => void>();
let unsubscribeFromLink: (() => void) | null = null;

/**
 * Moved by every event and every read or open this store starts, so an answer
 * to a question asked before the latest one can never overwrite it. An event
 * wins over a read in flight: it was sent after the read was asked, and the
 * service emits one for every change, so the store converges on the last one.
 */
let generation = 0;

/**
 * Set when an End returns, answered or refused, and cleared by the next
 * publish. The service emits the End's event before it answers, but the store
 * cannot tell that event's state from an earlier one whose successor it
 * missed, so after an End a failed read keeps nothing.
 */
let endedSinceShown = false;

function publish(next: OneTimeStoreState): void {
  snapshot = next;
  endedSinceShown = false;
  for (const listener of listeners) listener();
}

export function getOneTimeSnapshot(): OneTimeStoreState {
  return snapshot;
}

export function subscribeToOneTime(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    const active = burrowLink();
    if (active) {
      unsubscribeFromLink = active.on('one-time', (data) => {
        // A bridge that relays something else under the name is dropped here
        // rather than rendered: the panel keys its copy off these fields.
        const state = (data as Partial<OneTimeEvent> | undefined)?.state;
        if (!isOneTimeState(state)) return;
        generation++;
        publish({ kind: 'ready', state });
      });
      void refreshOneTime();
    } else {
      publish(UNSUPPORTED);
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeFromLink?.();
      unsubscribeFromLink = null;
      // The next subscriber re-reads rather than trusting a mirror nobody kept
      // current, and a read still in flight cannot land on it.
      snapshot = LOADING;
      generation++;
    }
  };
}

/**
 * Re-read `oneTimeStatus`. The panel calls it on mount: the Baseboard keeps
 * this store subscribed for the life of the window, so a first read that
 * failed at boot would otherwise leave the panel on that error until the next
 * event.
 */
export async function refreshOneTime(): Promise<void> {
  const active = burrowLink();
  if (!active) {
    publish(UNSUPPORTED);
    return;
  }
  const mine = ++generation;
  let next: OneTimeStoreState;
  try {
    const state = await active.command('oneTimeStatus');
    next = isOneTimeState(state)
      ? { kind: 'ready', state }
      : { kind: 'error', message: describeBurrowError(undefined) };
  } catch (error) {
    next = { kind: 'error', message: describeBurrowError(error) };
  }
  if (mine !== generation) return;
  // A state already read stands, kept current by the events: the Baseboard
  // holds this store for the window's life, and one failed re-read must not
  // hide a connected phone.
  if (next.kind === 'error' && snapshot.kind === 'ready' && !endedSinceShown) return;
  publish(next);
}

/**
 * Open a one-time connection — the panel's button and New link. Takes nothing:
 * the rendezvous is this build's, never the webview's to name.
 *
 * The service's events carry every state the open moves through, and arrive
 * before its answer; the answer is applied only when none has (a stub with no
 * events, a bridge that lost one). Rejections propagate verbatim — the panel
 * renders them, and the service's refusals are written to be read.
 */
export async function openOneTime(): Promise<void> {
  const active = requireBurrowLink();
  const mine = ++generation;
  const state = await active.command('oneTimeOpen');
  if (mine === generation && isOneTimeState(state)) publish({ kind: 'ready', state });
}

/**
 * End the live connection (End, Cancel), or put an ended one back to `idle`
 * (Done) — the service decides which from its own state. Its answer is `{}`,
 * so the state is re-read rather than guessed.
 */
export async function endOneTime(): Promise<void> {
  const active = requireBurrowLink();
  try {
    await active.command('oneTimeEnd');
  } finally {
    endedSinceShown = true;
  }
  await refreshOneTime();
}
