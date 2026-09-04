/**
 * Push notifications for unattended alarms (`docs/specs/alert.md` -> Push
 * notifications). When a Session rings and stays unattended for `pushDelayMs`,
 * send that Pane's name to the paired phones.
 *
 * The ring detection, delay, and cancellation rules are shared with spoken
 * alarms (`lib/src/lib/alert-ring-watch.ts`); this module is the webview half of
 * the push sink — the watch, the pane label, and the settings dialog's device
 * list. The Relay calls themselves are in `push-delivery.ts`, which a
 * Node-resident Burrow runs without any of this.
 *
 * It lives under `remote/burrow/` rather than `lib/` because it is only meaningful
 * with a Burrow behind it, and because that keeps it inside the lazily-imported
 * `RemotePairingModalHost` chunk — so a burrow that never sets `enableBurrow`
 * never fetches it.
 */

import { getAlertSettings } from '../../lib/alert-settings';
import { watchUnattendedRings } from '../../lib/alert-ring-watch';
import { deriveSessionLabel } from '../../lib/session-label';
import { setPushDevices, type PushDevice, type PushDevicesState } from '../../lib/push-devices';

let pushDevicesRefreshSequence = 0;

/**
 * Run `load` and publish its result to the dialog's store, fenced as below.
 * `load` goes over the service bridge (`activation.ts`), because the ACL the
 * list is joined against is the Burrow's — and it answers `null` when no Burrow is
 * running, which is "nowhere to push", not an empty list. Failure is reported
 * as `error` rather than an empty list: "we could not ask" and "no devices are
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

/**
 * Watch the activity store for fresh rings and hand the unattended ones to
 * `fire`, with the Session's display label already derived. Returns a disposer
 * that cancels everything pending.
 *
 * The label is derived here, in the webview, because that is where the pane
 * stores are — a Burrow in another process is told what the Session is called
 * rather than guessing (`push-delivery.ts`).
 */
export function watchPushRings(fire: (sessionId: string, title: string) => void): () => void {
  return watchUnattendedRings({
    enabled: () => getAlertSettings().pushEnabled,
    delayMs: () => getAlertSettings().pushDelayMs,
    fire: (id) => fire(id, deriveSessionLabel(id)),
  });
}
