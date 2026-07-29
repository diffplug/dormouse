/**
 * Which paired devices a push would actually reach (`docs/specs/alert.md` ->
 * Push notifications). Read by the Alarm settings dialog to fill
 * "Push will be sent to …".
 *
 * Renderer-only derived state, deliberately not an app-global store relayed
 * host-ward: it is neither persisted nor edited, so it pays none of the
 * per-store relay cost `docs/specs/transport.md` warns about.
 *
 * It lives in `lib/src/lib/` rather than beside the remote Host because the
 * dialog is in every bundle while the Host is lazily loaded in standalone only.
 * The Host writes; the dialog reads; a build without a Host leaves it at
 * `no-host` forever, which is exactly what the UI should say.
 */

export interface PushDevice {
  /** Base64url device identity — the Host ACL's `devicePublicKey`. */
  devicePublicKey: string;
  /** Human name from the Host's ACL record, e.g. `iPhone Safari`. */
  label: string;
}

export type PushDevicesStatus =
  /** No remote Host is running, so push has nowhere to go. */
  | 'no-host'
  /** Asking the server which devices are subscribed. */
  | 'loading'
  | 'ready'
  /** The server could not be reached; the list is unknown, not empty. */
  | 'error';

export interface PushDevicesState {
  status: PushDevicesStatus;
  devices: PushDevice[];
}

const EMPTY: PushDevicesState = { status: 'no-host', devices: [] };

let state: PushDevicesState = EMPTY;
let refresh: (() => void) | null = null;
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
 * Install the Host's re-read of the device list, so a consumer can ask for a
 * fresh one without importing the Host (which is lazily loaded and absent from
 * most bundles). Cleared by {@link resetPushDevices}.
 */
export function setPushDevicesRefresher(next: (() => void) | null): void {
  refresh = next;
}

/**
 * Ask the Host to re-read the list, if one is running. Called when the Alarm
 * settings dialog opens: subscriptions come and go on the phone long after the
 * Host started, so a list only fetched at startup would name the wrong devices
 * — or none — for the rest of the session.
 */
export function refreshPushDevicesNow(): void {
  refresh?.();
}

/** Back to `no-host`, for a Host that stopped or a test that finished. */
export function resetPushDevices(): void {
  refresh = null;
  setPushDevices(EMPTY);
}
