/** Browser-only push setup; `PocketClient.subscribeToPush` registers it with the Relay. */

import {
  fromBase64Url,
  pushEndpointFingerprint,
  type PushSubscriptionPayload,
} from 'remote-lib-common';
import { getPushServiceWorkerRegistration } from '../pocket-app/service-worker';

/** Why the user cannot subscribe now, or `ready`; see pocket-app.md. */
export type PushAvailability =
  | 'ready'
  | 'unsupported'
  | 'needs-install'
  | 'no-worker'
  | 'denied';

export function isInstalledWebApp(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  return globalThis.matchMedia?.('(display-mode: standalone)').matches ?? false;
}

/** `navigator.standalone` presence identifies iOS without unreliable UA parsing. */
export function requiresInstallForPush(): boolean {
  return typeof (navigator as Navigator & { standalone?: boolean }).standalone === 'boolean';
}

/**
 * iOS running in a browser tab. Exported on its own because it gates more than
 * push: everything partition-bound — the device key, the cached passkey — is
 * minted into the tab's storage, so the auth screen asks this before setup
 * rather than waiting on the push machinery `getPushAvailability` probes.
 */
export function needsHomeScreenInstall(): boolean {
  return requiresInstallForPush() && !isInstalledWebApp();
}

export async function getPushAvailability(): Promise<PushAvailability> {
  // Keep first: an iOS tab lacks the APIs below but the actionable result is install.
  if (needsHomeScreenInstall()) return 'needs-install';
  if (
    !('serviceWorker' in navigator) ||
    typeof globalThis.Notification !== 'function' ||
    !('PushManager' in globalThis)
  ) {
    return 'unsupported';
  }

  // Boot starts registration asynchronously; await its tracked result.
  const registration = await getPushServiceWorkerRegistration();
  if (!registration) return 'no-worker';

  if (Notification.permission === 'denied') return 'denied';
  return 'ready';
}

/**
 * Whether permission and the local subscription still match the Relay row.
 * A null endpoint digest is “no opinion,” preserving pre-fingerprint registrations.
 */
export async function hasCurrentPushSubscription(
  applicationServerKey: string,
  registeredEndpoint: string | null,
): Promise<boolean> {
  if (
    !('serviceWorker' in navigator) ||
    typeof globalThis.Notification !== 'function' ||
    Notification.permission !== 'granted' ||
    !('PushManager' in globalThis)
  ) {
    return false;
  }
  const registration = await getPushServiceWorkerRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return false;
  if (!sameBytes(subscription.options.applicationServerKey, fromBase64Url(applicationServerKey))) {
    return false;
  }
  if (registeredEndpoint === null) return true;
  return (await pushEndpointFingerprint(subscription.endpoint)) === registeredEndpoint;
}

/**
 * Ask for permission and subscribe. Must run in a user gesture for iOS.
 * `onDeliveryAddressReplaced` fires before minting because minting may fail
 * after the old address is already invalid.
 */
export async function subscribeToPushInBrowser(
  applicationServerKey: string,
  onDeliveryAddressReplaced: () => void,
): Promise<PushSubscriptionPayload> {
  // Checked before the permission prompt so a missing worker fails with an
  // explanation rather than after the user has already answered a dialog.
  const registration = await getPushServiceWorkerRegistration();
  if (!registration) {
    throw new Error(
      'Dormouse could not start its background worker, so it cannot receive push. ' +
        'This usually means the Relay is not being served over https.',
    );
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Enable them in your browser settings.'
        : 'Notification permission was dismissed.',
    );
  }

  // One scope subscription serves every Burrow; rotate only when the VAPID key changed.
  const applicationServerKeyBytes = fromBase64Url(applicationServerKey);
  let subscription = await registration.pushManager.getSubscription();
  if (
    subscription &&
    !sameBytes(subscription.options.applicationServerKey, applicationServerKeyBytes)
  ) {
    await subscription.unsubscribe().catch(() => undefined);
    subscription = null;
  }

  // Match the `??=` predicate and announce loss before the fallible subscribe.
  if (subscription == null) onDeliveryAddressReplaced();
  subscription ??= await registration.pushManager.subscribe({
    // Mandatory in Chrome/iOS; sw.js makes every delivery visible.
    userVisibleOnly: true,
    // Passed as bytes rather than the base64url string: browsers disagree about
    // accepting the string form.
    applicationServerKey: applicationServerKeyBytes as BufferSource,
  });

  const json = subscription.toJSON() as { endpoint?: string; keys?: Record<string, string> };
  const endpoint = json.endpoint ?? subscription.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    throw new Error('The browser returned an incomplete push subscription.');
  }
  return { endpoint, keys: { p256dh, auth } };
}

/** A missing reported key mismatches, safely forcing rotation. */
function sameBytes(actual: ArrayBuffer | null, expected: Uint8Array): boolean {
  if (!actual) return false;
  const bytes = new Uint8Array(actual);
  return bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index]);
}
