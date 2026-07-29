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

import { API_ROUTES, type HostAclRecord, type PushDevicesResponse } from 'server-lib-common';
import { getAlertSettings } from '../../lib/alert-settings';
import { watchUnattendedRings } from '../../lib/alert-ring-watch';
import { deriveSessionLabel } from '../../lib/session-label';
import { setPushDevices, type PushDevice } from '../../lib/push-devices';
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
 * Reduce a display label to something safe to put in an OS notification.
 *
 * Deliberately NOT `toSpokenText`. That function strips angle brackets because
 * WebKit's speech synthesizer wedges on them — irrelevant here, and it would
 * mangle a perfectly good title like `<idle>` for no reason. What matters at
 * this sink is different: the string crosses a network to a third-party push
 * service and is rendered by the OS, and it is ultimately terminal-supplied
 * (`OSC 0`/`2`/`9` titles reach the Pane label — `docs/specs/alert.md` -> Text
 * And Security).
 *
 * So: control characters go, and so do the Unicode bidi and zero-width format
 * characters, which can visually reorder or hide text in a notification —
 * a spoofing vector a program could otherwise aim at your lock screen.
 */
export function toPushText(label: string): string {
  const cleaned = label
    // C0, DEL, and C1 control characters.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    // Zero-width and joiner characters, bidi embedding/override marks, bidi
    // isolates, and the BOM. Dropped rather than spaced: they carry no width,
    // so replacing them would invent gaps in an otherwise fine title.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, PUSH_TITLE_LIMIT).trim() || 'terminal';
}

export interface AlertPushDeps {
  readonly enrollment: Pick<HostEnrollment, 'serverUrl' | 'hostToken'>;
  /** The Host's active ACL records — the authority on who may be reached. */
  readonly activeRecords: () => readonly HostAclRecord[];
  /** Injectable for tests. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The devices a push may go to: subscribed on the Server **and** still active in
 * the Host's ACL.
 *
 * The intersection is the security-relevant half. A revoked Client keeps its
 * server-side subscription row — nothing propagates a revocation today
 * (`docs/specs/remote-security-model.md` -> Future) — so a Host that let the
 * Server fan out on its own would keep pushing Pane labels to a phone it had
 * already de-authorized. Naming the targets keeps the access decision on the
 * Host, where the model puts it.
 */
async function loadPushDevices(deps: AlertPushDeps): Promise<PushDevice[]> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const response = await doFetch(`${deps.enrollment.serverUrl}${API_ROUTES.pushDevices}`, {
    headers: { authorization: `Bearer ${deps.enrollment.hostToken}` },
  });
  if (!response.ok) throw new Error(`push devices failed (${response.status})`);
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
 * Refresh the push-device list the Alarm settings dialog reads. Failure is
 * reported as `error` rather than an empty list: "we could not ask" and "no
 * devices are subscribed" are different things to show a user.
 */
export async function refreshPushDevices(deps: AlertPushDeps): Promise<void> {
  setPushDevices({ status: 'loading', devices: [] });
  try {
    setPushDevices({ status: 'ready', devices: await loadPushDevices(deps) });
  } catch {
    setPushDevices({ status: 'error', devices: [] });
  }
}

async function sendPush(deps: AlertPushDeps, sessionId: string): Promise<void> {
  // Re-read the targets at send time rather than trusting a cached list: a
  // device revoked since the last refresh must not be pushed to.
  const devices = await loadPushDevices(deps);
  if (devices.length === 0) return;

  const doFetch = deps.fetch ?? globalThis.fetch;
  await doFetch(`${deps.enrollment.serverUrl}${API_ROUTES.pushSend}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${deps.enrollment.hostToken}`,
    },
    body: JSON.stringify({
      devicePublicKeys: devices.map((d) => d.devicePublicKey),
      title: toPushText(deriveSessionLabel(sessionId)),
      body: PUSH_BODY,
      // Per-Session collapse key: a Pane that rings, is cleared, and rings again
      // replaces its own notification rather than stacking copies. Internal ids
      // only — a tag is never displayed.
      tag: sessionId,
    }),
  });
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
