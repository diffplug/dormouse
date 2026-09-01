/**
 * Delivering a push (`docs/specs/alert.md` -> Push notifications): what the Host
 * posts, and the rule that the Host's own ACL — read at send time — chooses who
 * is reached. The transport those calls run under is `host-fetch.ts`, shared
 * with the setup-token mint.
 *
 * Split from `alert-push.ts` because the two halves run in different processes
 * once the Host is Node-resident: ring *detection* is webview state (the
 * activity store, the alarm settings, the pane's label), while *delivery* needs
 * the enrollment and the ACL, which only the Host holds. Nothing here touches
 * the DOM or a store, so it runs unchanged in a webview or in the sidecar.
 *
 * Delivery is an HTTP POST to the Server rather than a relay frame: the relay
 * routes between two live sockets, and the whole point of a push is reaching a
 * phone whose app is closed.
 */

import {
  API_ROUTES,
  PUSH_SEND_DEADLINE_MS,
  boundedPushText,
  type HostAclRecord,
  type PushDevicesResponse,
  type PushSendResponse,
} from 'server-lib-common';
import type { PushSendSummary } from '../../host/remote/service-protocol';
import type { PushDevice } from '../../lib/push-devices';
import type { HostEnrollment } from './enrollment';
import { hostFetch } from './host-fetch';

/**
 * Longest label we put in a notification title. Every OS truncates well before
 * this on a lock screen; the cap exists so a pathological title cannot bloat
 * the encrypted payload toward the ~4KB Web Push limit.
 */
const PUSH_TITLE_LIMIT = 100;

/** Shown as the notification body; the Pane name carries the information. */
const PUSH_BODY = 'Needs attention';

/**
 * The Settings dialog's test push. The title says plainly that nothing is
 * actually waiting, so a test that arrives on a phone hours later — or on
 * someone else's phone — cannot be mistaken for a real alarm.
 */
export const PUSH_TEST_TITLE = 'Dormouse test — nothing needs attention';

/** Collapse key for the test, so repeated presses replace rather than stack. */
export const PUSH_TEST_TAG = 'dormouse-push-test';

/**
 * Headroom over the Server's own per-attempt deadline, covering the round trip
 * and the fan-out's bookkeeping. Small on purpose: the timeout is still there
 * to stop a wedged relay holding the Host.
 *
 * This is the one Host→Server call that runs *past* the webview's 15 s command
 * budget, and deliberately: a send is normally fired by the alert path inside
 * the Host process, where no webview is waiting at all. Only the Settings
 * dialog's test push is webview-initiated, and there the button giving up first
 * is the right answer — the send it started still finishes.
 */
const PUSH_SEND_MARGIN_MS = 5_000;

/**
 * Apply this sink's bounds to a Pane label. The rule itself is
 * `boundedPushText` in `server-lib-common`, shared with the Server so the
 * sanitization has one implementation rather than a strong copy here and a
 * weaker one there; this wrapper only names the sink's limit and fallback.
 */
export function toPushText(label: string): string {
  return boundedPushText(label, { limit: PUSH_TITLE_LIMIT, fallback: 'terminal' });
}

/** A `HostFetchOptions` (`host-fetch.ts`) plus the authority on who is reached. */
export interface AlertPushDeps {
  readonly enrollment: Pick<HostEnrollment, 'serverUrl' | 'hostToken'>;
  /** The Host's active ACL records — the authority on who may be reached. */
  readonly activeRecords: () => readonly HostAclRecord[];
  /** Injectable for tests. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The devices the settings dialog names: subscribed on the Server **and** still
 * active in the Host's ACL, joined by `deliveryId` to the ACL's human labels.
 *
 * Only the Host can do this join — it holds the records that mint delivery ids,
 * and the Server never learns a label
 * (`docs/specs/remote-security-model.md`). The send path does not need it, and
 * deliberately does not pay for it; see {@link sendPush}.
 */
export async function loadPushDevices(deps: AlertPushDeps): Promise<PushDevice[]> {
  const response = await hostFetch(deps, API_ROUTES.pushDevices);
  const body = (await response.json()) as PushDevicesResponse;

  const labels = new Map(deps.activeRecords().map((r) => [r.deliveryId, r.label]));
  return body.devices
    .filter((device) => labels.has(device.deliveryId))
    .map((device) => ({
      deliveryId: device.deliveryId,
      label: labels.get(device.deliveryId) || 'Unnamed device',
    }));
}

/**
 * Push `title` for one Session to every device the ACL still authorizes.
 *
 * The label is passed in rather than derived: it comes from the pane stores,
 * which live in the webview, so a Host in another process is told what the
 * Session is called and never guesses.
 */
export async function sendPush(
  deps: AlertPushDeps,
  sessionId: string,
  title: string,
): Promise<PushSendSummary> {
  // Read straight from the ACL, which is local and in-memory, rather than
  // asking the Server which devices are subscribed: the Server intersects the
  // names it is given with its own subscriptions anyway, so the target set is
  // identical and this costs one round trip instead of two on the one path
  // whose whole value is timeliness.
  //
  // Naming targets at all is the security-relevant part. Nothing propagates a
  // revocation today (`docs/specs/remote-security-model.md` -> Future), so a
  // revoked Client keeps its subscription row; letting the Server choose
  // recipients would keep pushing Pane labels to a de-authorized phone. Read at
  // send time, so a revocation during the delay takes effect.
  const deliveryIds = deps.activeRecords().map((record) => record.deliveryId);
  if (deliveryIds.length === 0) return { targeted: 0, delivered: 0, failed: 0 };

  const response = await hostFetch(
    // The one call that outlives the shared budget: the Server holds a send open
    // for up to `PUSH_SEND_DEADLINE_MS` per attempt, so aborting at the default
    // 10 s would report deliveries that actually succeeded as failures. Derived
    // from the Server's own bound plus a margin for the round trip.
    { ...deps, timeoutMs: PUSH_SEND_DEADLINE_MS + PUSH_SEND_MARGIN_MS },
    API_ROUTES.pushSend,
    {
      deliveryIds,
      title: toPushText(title),
      body: PUSH_BODY,
      // Per-Session collapse key: a Pane that rings, is cleared, and rings again
      // replaces its own notification rather than stacking copies. Internal ids
      // only — a tag is never displayed.
      tag: sessionId,
    },
  );
  // `hostFetch` threw on a non-2xx; this is the quieter failure class — the
  // Server accepted the send but a push service refused delivery, which it
  // reports in counts on an HTTP 200. Without this check an all-failed fan-out
  // is indistinguishable from success.
  const result = (await response.json()) as PushSendResponse;
  if (result.failed > 0 || result.delivered === 0) {
    console.warn('remote-host: push was not delivered to every device', result);
  }
  return { targeted: deliveryIds.length, delivered: result.delivered, failed: result.failed };
}
