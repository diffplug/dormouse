/**
 * Which paired devices a push would actually reach (`docs/specs/alert.md` ->
 * Push notifications). Read by the Alarm settings dialog to fill
 * "Push will be sent to …".
 *
 * Renderer-only derived state, deliberately not an app-global store relayed
 * host-ward: it is neither persisted nor edited, so it pays none of the
 * per-store relay cost `docs/specs/transport.md` warns about.
 *
 * It lives in `lib/src/lib/` rather than beside the Burrow because the
 * dialog is in every bundle while the Burrow is lazily loaded in standalone only.
 * The Burrow writes; the dialog reads; a build without a Burrow leaves it at
 * `no-burrow` forever, which is exactly what the UI should say.
 */

export interface PushDevice {
  /**
   * Human name from the Burrow's ACL record, e.g. `iPhone Safari` — and nothing
   * else. The record's `deliveryId` is a bearer capability for that Client's
   * push rows, so it stays on the Burrow side of the bridge; the dialog renders a
   * label and never addresses a device (`docs/specs/security-remote.md` → "What crosses the
   * boundary").
   */
  label: string;
}

export type PushDevicesStatus =
  /** No Burrow is running, so push has nowhere to go. */
  | 'no-burrow'
  /** Asking the server which devices are subscribed. */
  | 'loading'
  | 'ready'
  /** The server could not be reached; the list is unknown, not empty. */
  | 'error';

export interface PushDevicesState {
  status: PushDevicesStatus;
  devices: PushDevice[];
}

const EMPTY: PushDevicesState = { status: 'no-burrow', devices: [] };

let state: PushDevicesState = EMPTY;
let refresh: (() => void) | null = null;
/** Bumped by every refresh and every clear; a refresh commits only while it is current. */
let refreshSequence = 0;
const listeners = new Set<() => void>();

/** Stable-identity snapshot for `useSyncExternalStore`. */
export function getPushDevices(): PushDevicesState {
  return state;
}

export function subscribeToPushDevices(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Replace the list. Identity-guarded so a repeat write does not churn React. */
export function setPushDevices(next: PushDevicesState): void {
  if (next.status === state.status && next.devices === state.devices) return;
  state = next;
  listeners.forEach((listener) => listener());
}

/**
 * Install the Burrow's re-read of the device list, so a consumer can ask for a
 * fresh one without importing the Burrow (which is lazily loaded and absent from
 * most bundles). Cleared by {@link resetPushDevices}.
 */
export function setPushDevicesRefresher(next: (() => void) | null): void {
  refresh = next;
}

/**
 * Ask the Burrow to re-read the list, if one is running. Called when the Alarm
 * settings dialog opens: subscriptions come and go on the phone long after the
 * Burrow started, so a list only fetched at startup would name the wrong devices
 * — or none — for the rest of the session.
 */
export function refreshPushDevicesNow(): void {
  refresh?.();
}

/**
 * Run `load` and publish its result, fenced on request order: overlapping
 * refreshes are latest-request-wins, so a slow startup refresh cannot overwrite
 * a newer dialog refresh, and a {@link clearPushDevices} since the request
 * discards it. `load` is the Burrow's `pushDevices` command
 * (`lib/src/remote/burrow/activation.ts`), which answers `null` when no Burrow
 * is running — "nowhere to push", rendered `no-burrow`, not an empty list. A
 * failure is `error`: "we could not ask" and "no devices are subscribed" are
 * different things to show a user.
 */
export async function commitPushDevices(load: () => Promise<PushDevice[] | null>): Promise<void> {
  const sequence = ++refreshSequence;
  const commit = (next: PushDevicesState) => {
    if (refreshSequence === sequence) setPushDevices(next);
  };
  commit({ status: 'loading', devices: [] });
  try {
    const devices = await load();
    commit(devices ? { status: 'ready', devices } : { status: 'no-burrow', devices: [] });
  } catch {
    commit({ status: 'error', devices: [] });
  }
}

/**
 * Back to `no-burrow`, keeping the refresher: the enrolled gate's disarm when the
 * Burrow goes away, where the dialog must stop naming devices nothing can reach
 * but may still be opened and told `no-burrow` (`lib/src/remote/burrow/activation.ts`).
 * Every refresh in flight is discarded too: one already on the wire would
 * otherwise land afterwards and name phones the Burrow behind them is gone for.
 */
export function clearPushDevices(): void {
  refreshSequence += 1;
  setPushDevices(EMPTY);
}

/**
 * Full teardown: {@link clearPushDevices} *and* no refresher — a story or a test
 * that finished, where the closure that would answer is going away too. Anything
 * that only means "the Burrow is gone" wants {@link clearPushDevices}.
 */
export function resetPushDevices(): void {
  refresh = null;
  clearPushDevices();
}
