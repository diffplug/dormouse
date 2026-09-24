/**
 * The push device list the Settings dialog names (`docs/specs/alert.md` ->
 * Settings dialog): each refresh fenced so a stale answer never overwrites a
 * newer one, or a Burrow that went away. When a ring is pushed is the host's
 * delivery scheduler's (`lib/src/lib/alert-delivery-scheduler.ts`); the Relay
 * calls are `push-delivery.ts`, which a Node-resident Burrow runs.
 *
 * It lives under `remote/burrow/` rather than `lib/` because it is only
 * meaningful with a Burrow behind it, and because that keeps it inside the
 * lazily-imported `RemotePairingModalHost` chunk — so a host that never sets
 * `enableBurrow` never fetches it.
 */

import { setPushDevices, type PushDevice, type PushDevicesState } from '../../lib/push-devices';

let pushDevicesRefreshSequence = 0;

/**
 * Run `load` and publish its result to the dialog's store, fenced as below.
 * `load` goes over the service bridge (`activation.ts`) as a `pushDevices`
 * command, because the ACL the list is joined against is the Burrow's — and it
 * answers `null` when no Burrow is running, which is "nowhere to push"
 * (rendered `no-burrow`), not an empty list. Failure is reported as `error`
 * rather than an empty list: "we could not ask" and "no devices are
 * subscribed" are different things to show a user.
 */
export async function commitPushDevices(
  load: () => Promise<PushDevice[] | null>,
): Promise<void> {
  // Writes are fenced on request order: overlapping requests are
  // latest-request-wins, so a slow startup refresh cannot overwrite a newer
  // dialog refresh. Which Burrow answered needs no fence of its own — the service
  // reads its own ACL at request time, and a Burrow that stopped answers
  // `no-burrow` like any other state.
  const sequence = ++pushDevicesRefreshSequence;
  const commit = (next: PushDevicesState) => {
    if (pushDevicesRefreshSequence === sequence) setPushDevices(next);
  };
  // The same fence covers {@link invalidatePushDeviceRefreshes}: a Burrow that
  // went away is not a newer request, but it has the same claim on the result.
  commit({ status: 'loading', devices: [] });
  try {
    const devices = await load();
    commit(devices ? { status: 'ready', devices } : { status: 'no-burrow', devices: [] });
  } catch {
    commit({ status: 'error', devices: [] });
  }
}

/**
 * Discard every refresh currently in flight.
 *
 * Called when the Burrow goes away (`activation.ts`, the enrolled gate's disarm).
 * A request that was already on the wire resolves afterwards and would otherwise
 * repopulate the dialog with devices there is no longer anything to push to —
 * the list would name phones and the Burrow behind them would be gone.
 */
export function invalidatePushDeviceRefreshes(): void {
  pushDevicesRefreshSequence += 1;
}
