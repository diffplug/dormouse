/**
 * Web Push delivery (docs/specs/alert.md -> Push notifications, docs/specs/relay.md).
 *
 * The relay cannot do this job: it routes between two live sockets and answers
 * "burrow <id> is offline" when a peer is missing. A push has to reach a phone
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

import { createECDH, timingSafeEqual } from 'node:crypto';

import webpush from 'web-push';

import {
  PUSH_TTL_SECONDS,
  defaultVapidSubject,
  isLoopbackVapidSubject,
  normalizeOrigin,
} from 'remote-lib-common';

import type { StoredPushSubscription } from './state.js';
import {
  createPublicPushAgent,
  isPublicHttpsPushEndpoint,
} from './push-endpoint.js';

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
 * The VAPID subject this Relay signs with when `DORMOUSE_VAPID_SUBJECT` is
 * unset: its https origin, or `null` when there is none push can use. Shared
 * with the Hosted Relay (`remote-lib-common/src/remote/web-push.ts`).
 */
export { defaultVapidSubject };

/** Generate a VAPID keypair in the exact encoding the sender expects. */
export function generateVapidKeys(): VapidKeys {
  return webpush.generateVAPIDKeys();
}

/**
 * Fail-fast validation for configured or persisted VAPID keys.
 *
 * `web-push` validates each key's shape only when sending and does not verify
 * that the public key belongs to the private key. Derive the P-256 public point
 * here so a mismatched pair cannot let the Relay start in a state where every
 * delivery will fail.
 */
export function assertVapidKeyPair(keys: VapidKeys): void {
  const publicKey = decodeVapidKey(keys.publicKey, 'public', 65);
  const privateKey = decodeVapidKey(keys.privateKey, 'private', 32);

  let derivedPublicKey: Buffer;
  try {
    const curve = createECDH('prime256v1');
    curve.setPrivateKey(privateKey);
    derivedPublicKey = curve.getPublicKey();
  } catch {
    throw new Error('VAPID private key is not a valid P-256 scalar.');
  }

  if (!timingSafeEqual(publicKey, derivedPublicKey)) {
    throw new Error('VAPID public and private keys do not form a matching keypair.');
  }
}

/**
 * Validate the operator contact before the first delivery. `web-push` performs
 * the syntax half of this check while constructing a send, which would
 * otherwise let a malformed environment value survive startup and fail every
 * notification at runtime.
 *
 * The loopback rule is stricter than `web-push`'s: it warns about a loopback
 * *https* subject on every send and says nothing at all about `mailto:` at
 * `localhost`, and a warning buried in send-time stderr is exactly how a
 * deployment ends up delivering nothing to iPhones without noticing.
 */
export function assertVapidSubject(subject: string): void {
  let parsed: URL;
  try {
    parsed = new URL(subject);
  } catch {
    throw new Error('VAPID subject must be a valid mailto: or https: URL.');
  }
  if (parsed.protocol !== 'mailto:' && parsed.protocol !== 'https:') {
    throw new Error('VAPID subject must be a valid mailto: or https: URL.');
  }
  if (isLoopbackVapidSubject(subject)) {
    throw new Error(
      'VAPID subject must not name a loopback host — Apple rejects such a JWT with ' +
        'BadJwtToken, so every push to an iPhone would fail. Use a routable contact, ' +
        "e.g. this Relay's https origin or a real mailto: address.",
    );
  }
}

function decodeVapidKey(value: string, name: 'public' | 'private', length: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`VAPID ${name} key must be unpadded base64url.`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== length || decoded.toString('base64url') !== value) {
    throw new Error(`VAPID ${name} key must decode to exactly ${length} bytes.`);
  }
  return decoded;
}

/**
 * Real delivery through `web-push`, at the shared `PUSH_TTL_SECONDS`. The
 * request timeout is a separate bound on socket inactivity while talking to
 * the push service.
 */
export { PUSH_TTL_SECONDS };
export const PUSH_REQUEST_TIMEOUT_MS = 10_000;

// The third bound of the trio, `PUSH_SEND_DEADLINE_MS`, lives in
// `remote-lib-common` rather than here: it is deliberately above
// PUSH_REQUEST_TIMEOUT_MS so it only fires where socket inactivity cannot, and
// the Burrow has to size its own request timeout above it in turn.

/**
 * Run one send under a wall-clock deadline, reporting `failed` if it does not
 * finish in time. Applied by the send route rather than by
 * {@link createWebPushSender}, so the bound holds for whatever {@link PushSender}
 * is injected and is stated where the route's own latency contract lives.
 *
 * The deadline bounds the *route*, not the socket: `web-push` accepts no
 * `AbortSignal`, so a request that loses the race is left to its own
 * inactivity timeout rather than cancelled. What this prevents is a hung push
 * service holding the handler open indefinitely and letting successive alarms
 * pile up concurrent sends.
 */
export async function sendWithinDeadline(
  sender: PushSender,
  target: PushTarget,
  payload: string,
  deadlineMs: number,
): Promise<PushDeliveryResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      // A `PushSender` is contracted to classify its own errors, but it is an
      // injection point — a throwing one must not take the whole fan-out down.
      Promise.resolve().then(() => sender.send(target, payload)).catch(() => 'failed' as const),
      new Promise<PushDeliveryResult>((resolve) => {
        timer = setTimeout(() => {
          // Same reasoning as the failure log below: origin only, and this is
          // the only trace a wedged push service leaves.
          console.warn(
            `push delivery exceeded ${deadlineMs}ms for ${endpointOrigin(target.endpoint)}`,
          );
          resolve('failed');
        }, deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function endpointOrigin(endpoint: string): string {
  return normalizeOrigin(endpoint) ?? '<invalid endpoint>';
}

/**
 * The push service's own explanation of a rejection, e.g. Apple's
 * `{"reason":"BadJwtToken"}`. Worth logging because the status code alone does
 * not distinguish a bad VAPID subject from a bad key from a bad payload, and
 * this is the only place that explanation is ever visible. Whitespace-collapsed
 * and capped so an HTML error page cannot flood the log.
 */
const MAX_LOGGED_ERROR_BODY = 200;

function pushErrorDetail(err: unknown): string {
  const body = (err as { body?: unknown }).body;
  if (typeof body !== 'string') return '';
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  return collapsed.length > MAX_LOGGED_ERROR_BODY
    ? `${collapsed.slice(0, MAX_LOGGED_ERROR_BODY)}…`
    : collapsed;
}

export function createWebPushSender(keys: VapidKeys, subject: string): PushSender {
  const agent = createPublicPushAgent();
  return {
    async send(target, payload) {
      try {
        // The registration route applies the same cheap check, but enforce it
        // again for legacy or manually edited state. Node may connect to an IP
        // literal without invoking the Agent's DNS lookup.
        if (!isPublicHttpsPushEndpoint(target.endpoint)) {
          throw new Error('push endpoint is not a public HTTPS URL');
        }
        await webpush.sendNotification(
          { endpoint: target.endpoint, keys: { ...target.keys } },
          payload,
          {
            vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
            TTL: PUSH_TTL_SECONDS,
            timeout: PUSH_REQUEST_TIMEOUT_MS,
            urgency: 'high',
            agent,
          },
        );
        return 'delivered';
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404/410 is the push service's way of saying the subscription is dead
        // for good — the browser was uninstalled, permission revoked, or the
        // endpoint rotated. Anything else may succeed on the next alarm.
        if (status === 404 || status === 410) return 'expired';
        // The only trace this failure leaves: the send route folds it into a
        // count, so a rotated VAPID key or a wedged push service would
        // otherwise fail every alarm with nothing anywhere. The endpoint is a
        // bearer capability — log its origin only.
        console.warn(
          `push delivery failed for ${endpointOrigin(target.endpoint)}:`,
          status ?? (err instanceof Error ? err.message : String(err)),
          pushErrorDetail(err),
        );
        return 'failed';
      }
    },
  };
}
