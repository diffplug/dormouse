/**
 * Delivering a push (`docs/specs/alert.md` -> Push notifications): the Host's
 * authenticated calls to the Server, and the rule that the Host's own ACL — read
 * at send time — chooses who is reached.
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
  boundedPushText,
  type HostAclRecord,
  type PushDevicesResponse,
  type PushSendResponse,
} from 'server-lib-common';
import type { PushDevice } from '../../lib/push-devices';
import type { HostEnrollment } from './enrollment';

/**
 * Longest label we put in a notification title. Every OS truncates well before
 * this on a lock screen; the cap exists so a pathological title cannot bloat
 * the encrypted payload toward the ~4KB Web Push limit.
 */
const PUSH_TITLE_LIMIT = 100;

/** Shown as the notification body; the Pane name carries the information. */
const PUSH_BODY = 'Needs attention';

/**
 * Apply this sink's bounds to a Pane label. The rule itself is
 * `boundedPushText` in `server-lib-common`, shared with the Server so the
 * sanitization has one implementation rather than a strong copy here and a
 * weaker one there; this wrapper only names the sink's limit and fallback.
 */
export function toPushText(label: string): string {
  return boundedPushText(label, { limit: PUSH_TITLE_LIMIT, fallback: 'terminal' });
}

export interface AlertPushDeps {
  readonly enrollment: Pick<HostEnrollment, 'serverUrl' | 'hostToken'>;
  /** The Host's active ACL records — the authority on who may be reached. */
  readonly activeRecords: () => readonly HostAclRecord[];
  /** Injectable for tests. */
  readonly fetch?: typeof globalThis.fetch;
}

/** The Host's one authenticated call to the Server. */
async function hostFetch(
  deps: AlertPushDeps,
  route: string,
  body?: unknown,
): Promise<Response> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const response = await doFetch(`${deps.enrollment.serverUrl}${route}`, {
    ...(body === undefined
      ? {}
      : { method: 'POST', body: JSON.stringify(body) }),
    // The service replaced a webview whose CSP checked every redirect target.
    // Do not let an allowed relay bounce the bearer token or notification
    // metadata to a destination outside the baked allowlist.
    redirect: 'error',
    headers: {
      authorization: `Bearer ${deps.enrollment.hostToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  });
  // Checked here so both call sites fail loudly. A send that swallowed a 401
  // from a revoked host token would leave push permanently broken and silent —
  // the failure mode this whole feature is most prone to.
  if (!response.ok) throw new Error(`${route} failed (${response.status})`);
  return response;
}

/**
 * The devices the settings dialog names: subscribed on the Server **and** still
 * active in the Host's ACL, joined to the ACL's human labels.
 *
 * Only the Host can do this join — it holds the ACL, and the Server never
 * learns a label (`docs/specs/remote-security-model.md`). The send path does
 * not need it, and deliberately does not pay for it; see {@link sendPush}.
 */
export async function loadPushDevices(deps: AlertPushDeps): Promise<PushDevice[]> {
  const response = await hostFetch(deps, API_ROUTES.pushDevices);
  const body = (await response.json()) as PushDevicesResponse;

  const labels = new Map(deps.activeRecords().map((r) => [r.devicePublicKey, r.label]));
  return body.devices
    .filter((device) => labels.has(device.devicePublicKey))
    .map((device) => ({
      devicePublicKey: device.devicePublicKey,
      label: labels.get(device.devicePublicKey) || 'Unnamed device',
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
): Promise<void> {
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
  const devicePublicKeys = deps.activeRecords().map((record) => record.devicePublicKey);
  if (devicePublicKeys.length === 0) return;

  const response = await hostFetch(deps, API_ROUTES.pushSend, {
    devicePublicKeys,
    title: toPushText(title),
    body: PUSH_BODY,
    // Per-Session collapse key: a Pane that rings, is cleared, and rings again
    // replaces its own notification rather than stacking copies. Internal ids
    // only — a tag is never displayed.
    tag: sessionId,
  });
  // `hostFetch` threw on a non-2xx; this is the quieter failure class — the
  // Server accepted the send but a push service refused delivery, which it
  // reports in counts on an HTTP 200. Without this check an all-failed fan-out
  // is indistinguishable from success.
  const result = (await response.json()) as PushSendResponse;
  if (result.failed > 0 || result.delivered === 0) {
    console.warn('remote-host: push was not delivered to every device', result);
  }
}
