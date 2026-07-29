/**
 * Web Push delivery (docs/specs/alert.md -> Push notifications, docs/specs/server.md).
 *
 * The relay cannot do this job: it routes between two live sockets and answers
 * "host <id> is offline" when a peer is missing. A push has to reach a phone
 * whose app is backgrounded or closed, which means handing the payload to the
 * platform's push service (APNs for Safari, FCM for Chrome) and letting it do
 * the waking.
 *
 * `web-push` carries RFC 8291 payload encryption (ECDH -> HKDF -> AES-128-GCM
 * with the aes128gcm framing) and the RFC 8292 VAPID JWT. Both are worth taking
 * a dependency for rather than hand-rolling: a subtly wrong HKDF info string
 * produces a push the phone silently fails to decrypt, with no error anywhere
 * we can see.
 *
 * Delivery is behind the {@link PushSender} seam so the send route can be
 * tested without a real push service, the same reason `AppConfig` takes an
 * injectable clock.
 */

import webpush from 'web-push';

import type { StoredPushSubscription } from './state.js';

/** What a push service needs to reach one browser. */
export interface PushTarget {
  readonly endpoint: string;
  readonly keys: StoredPushSubscription['keys'];
}

/**
 * `expired` means the push service says this subscription is permanently gone
 * (404/410) and the caller should forget it. `failed` is anything else — a
 * transient network error, a rate limit — and leaves the subscription alone.
 */
export type PushDeliveryResult = 'delivered' | 'expired' | 'failed';

export interface PushSender {
  send(target: PushTarget, payload: string): Promise<PushDeliveryResult>;
}

export interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
}

/**
 * `mailto:` or `https:` contact for the push service operator, per RFC 8292.
 * Push services may use it to reach whoever is responsible for a misbehaving
 * sender; some reject a JWT without one.
 */
export const DEFAULT_VAPID_SUBJECT = 'mailto:admin@localhost';

/** Generate a VAPID keypair in the exact encoding the sender expects. */
export function generateVapidKeys(): VapidKeys {
  return webpush.generateVAPIDKeys();
}

/**
 * Real delivery through `web-push`. TTL is deliberately short: an alarm that
 * arrives an hour late is noise, not information, so a push service holding one
 * for an offline phone should drop it rather than deliver it stale.
 */
export const PUSH_TTL_SECONDS = 300;

export function createWebPushSender(keys: VapidKeys, subject: string): PushSender {
  return {
    async send(target, payload) {
      try {
        await webpush.sendNotification(
          { endpoint: target.endpoint, keys: { ...target.keys } },
          payload,
          {
            vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
            TTL: PUSH_TTL_SECONDS,
            urgency: 'high',
          },
        );
        return 'delivered';
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404/410 is the push service's way of saying the subscription is dead
        // for good — the browser was uninstalled, permission revoked, or the
        // endpoint rotated. Anything else may succeed on the next alarm.
        if (status === 404 || status === 410) return 'expired';
        return 'failed';
      }
    },
  };
}
