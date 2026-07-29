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
const listeners = new Set<() => void>();

/** Stable-identity snapshot for `useSyncExternalStore`. */
export function getPushDevices(): PushDevicesState {
  return state;
}

export function subscribeToPushDevices(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function equal(a: PushDevicesState, b: PushDevicesState): boolean {
  if (a.status !== b.status || a.devices.length !== b.devices.length) return false;
  return a.devices.every(
    (device, i) =>
      device.devicePublicKey === b.devices[i]!.devicePublicKey &&
      device.label === b.devices[i]!.label,
  );
}

/** Replace the list. No-ops when nothing changed, so the dialog does not churn. */
export function setPushDevices(next: PushDevicesState): void {
  if (equal(next, state)) return;
  state = next;
  listeners.forEach((listener) => listener());
}

/** Back to `no-host`, for a Host that stopped or a test that finished. */
export function resetPushDevices(): void {
  setPushDevices(EMPTY);
}
