/**
 * Push notifications for unattended alarms (`docs/specs/alert.md` -> Push
 * notifications). When a Session rings and stays unattended for `pushDelayMs`,
 * send that Pane's name to the paired phones.
 *
 * The ring detection, delay, and cancellation rules are shared with spoken
 * alarms (`lib/src/lib/alert-ring-watch.ts`); this module is the push sink.
 * It lives under `remote/host/` rather than `lib/` because it needs the Host's
 * enrollment and ACL, and because that keeps it inside the lazily-imported
 * `RemotePairingModalHost` chunk — so the website and vscode webviews, which
 * never set `enableRemoteHost`, never fetch it.
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
import { getAlertSettings } from '../../lib/alert-settings';
import { watchUnattendedRings } from '../../lib/alert-ring-watch';
import { deriveSessionLabel } from '../../lib/session-label';
import {
  getPushDevicesGeneration,
  setPushDevices,
  type PushDevice,
  type PushDevicesState,
} from '../../lib/push-devices';
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
async function loadPushDevices(deps: AlertPushDeps): Promise<PushDevice[]> {
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

let pushDevicesRefreshSequence = 0;

/**
 * Refresh the push-device list the Alarm settings dialog reads. Failure is
 * reported as `error` rather than an empty list: "we could not ask" and "no
 * devices are subscribed" are different things to show a user.
 */
export async function refreshPushDevices(deps: AlertPushDeps): Promise<void> {
  // Writes are fenced on both Host generation and request order. Generation
  // discards a request that outlives stop/re-enrollment; sequence makes
  // overlapping requests for the same Host latest-request-wins, so a slow
  // startup refresh cannot overwrite a newer dialog refresh.
  const generation = getPushDevicesGeneration();
  const sequence = ++pushDevicesRefreshSequence;
  const commit = (next: PushDevicesState) => {
    if (
      getPushDevicesGeneration() === generation &&
      pushDevicesRefreshSequence === sequence
    ) {
      setPushDevices(next);
    }
  };
  commit({ status: 'loading', devices: [] });
  try {
    commit({ status: 'ready', devices: await loadPushDevices(deps) });
  } catch {
    commit({ status: 'error', devices: [] });
  }
}

async function sendPush(deps: AlertPushDeps, sessionId: string): Promise<void> {
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
    title: toPushText(deriveSessionLabel(sessionId)),
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

/**
 * Watch the activity store for fresh rings and push the unattended ones.
 * Returns a disposer that cancels everything pending.
 */
export function startAlertPush(deps: AlertPushDeps): () => void {
  return watchUnattendedRings({
    enabled: () => getAlertSettings().pushEnabled,
    delayMs: () => getAlertSettings().pushDelayMs,
    fire: (id) => {
      // A push that fails must never break the alert path, and there is nothing
      // useful to retry against — the alarm is already stale by the next ring.
      void sendPush(deps, id).catch((error: unknown) => {
        console.warn('remote-host: push notification failed', error);
      });
    },
  });
}
