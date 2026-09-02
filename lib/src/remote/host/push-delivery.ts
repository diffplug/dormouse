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
  MAX_PUSH_QUERY_DELIVERY_IDS,
  PUSH_SEND_DEADLINE_MS,
  boundedPushText,
  utf8Encode,
  type HostAclRecord,
  type PushDevicesResponse,
  type PushSendRequest,
  type PushSendResponse,
  type SealedPushRecipient,
  type SealedPushV1,
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
 * Longest collapse tag we seal. A tag is an internal id and is never displayed,
 * so this is a size bound on the plaintext rather than a sanitization rule —
 * but it runs through the same `boundedPushText`, so the worker re-applying
 * that rule at the sink cannot change what the Host sent.
 */
const PUSH_TAG_LIMIT = 64;

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
 * `boundedPushText` in `server-lib-common`, shared with the worker that
 * re-bounds at the render sink; this wrapper only names the limit and fallback.
 */
export function toPushText(label: string): string {
  return boundedPushText(label, { limit: PUSH_TITLE_LIMIT, fallback: 'terminal' });
}

/** A `HostFetchOptions` (`host-fetch.ts`) plus the authority on who is reached. */
export interface AlertPushDeps {
  readonly enrollment: Pick<HostEnrollment, 'serverUrl' | 'hostToken'>;
  /** The Host's active ACL records — the authority on who may be reached. */
  readonly activeRecords: () => readonly HostAclRecord[];
  /**
   * Seal one plaintext to one paired Client's static, or `null` when this Host
   * has no usable Noise static. A capability, never the key
   * (`docs/specs/remote-security-model.md` -> Push sealing).
   */
  readonly seal: (
    clientStaticPublicKey: string,
    plaintext: Uint8Array,
  ) => Promise<SealedPushV1 | null>;
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
 *
 * **One ciphertext per recipient**, sealed to that ACL record's own Client
 * static (`docs/specs/remote-security-model.md` -> Push sealing).
 */
export async function sendPush(
  deps: AlertPushDeps,
  sessionId: string,
  title: string,
): Promise<PushSendSummary> {
  // Read at send time, so a revocation during the ring delay takes effect
  // (`docs/specs/alert.md` -> Push notifications owns the recipient rule).
  const all = deps.activeRecords();
  if (all.length === 0) return { targeted: 0, delivered: 0, failed: 0 };
  // The send route refuses more than this, and it refuses the *whole* POST — so
  // an unclamped fan-out past the bound would reach nobody rather than most.
  //
  // **The newest end, not the oldest.** `activeRecords()` is in approval order,
  // and re-pairing a phone that lost its IndexedDB mints a fresh Client static,
  // which supersedes nothing — so the old record stays active forever, ahead of
  // its own replacement. Clamping from the front would push to dead records and
  // drop the phones actually in use.
  const records = all.slice(-MAX_PUSH_QUERY_DELIVERY_IDS);
  if (records.length !== all.length) {
    console.warn(
      `remote-host: ${all.length} devices are paired; pushing to the ${MAX_PUSH_QUERY_DELIVERY_IDS} most recent`,
    );
  }

  // Bounded here, before it is sealed, because this is the last layer that can
  // read it: what the worker re-sanitizes at the sink is whatever this
  // produced.
  const plaintext = utf8Encode(
    JSON.stringify({
      title: toPushText(title),
      body: PUSH_BODY,
      tag: boundedPushText(sessionId, { limit: PUSH_TAG_LIMIT, fallback: 'dormouse' }),
    }),
  );
  const recipients: SealedPushRecipient[] = [];
  for (const record of records) {
    const sealed = await deps.seal(record.clientStaticPublicKey, plaintext);
    if (sealed) recipients.push({ deliveryId: record.deliveryId, sealed });
  }
  if (recipients.length === 0) {
    // A Host with records but no usable static reaches nobody, and silently
    // would be indistinguishable from having no phones paired.
    console.warn('remote-host: no push could be sealed for any paired device');
    return { targeted: 0, delivered: 0, failed: 0 };
  }

  const response = await hostFetch(
    // The one call that outlives the shared budget: the Server holds a send open
    // for up to `PUSH_SEND_DEADLINE_MS` per attempt, so aborting at the default
    // 10 s would report deliveries that actually succeeded as failures. Derived
    // from the Server's own bound plus a margin for the round trip.
    { ...deps, timeoutMs: PUSH_SEND_DEADLINE_MS + PUSH_SEND_MARGIN_MS },
    API_ROUTES.pushSend,
    { recipients } satisfies PushSendRequest,
  );
  // `hostFetch` threw on a non-2xx; this is the quieter failure class — the
  // Server accepted the send but a push service refused delivery, which it
  // reports in counts on an HTTP 200. Without this check an all-failed fan-out
  // is indistinguishable from success.
  const result = (await response.json()) as PushSendResponse;
  if (result.failed > 0 || result.delivered === 0) {
    console.warn('remote-host: push was not delivered to every device', result);
  }
  return { targeted: recipients.length, delivered: result.delivered, failed: result.failed };
}
