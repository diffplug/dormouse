/**
 * The browser half of push subscription (docs/specs/pocket-app.md ->
 * Installable web app, docs/specs/alert.md -> Push notifications).
 *
 * This module only talks to browser APIs — permission, the service worker
 * registration, and `pushManager.subscribe`. Registering the result with the
 * Server is `PocketClient.subscribeToPush`, which already holds the session
 * token and the device key the Server demands.
 */

import { fromBase64Url, type PushSubscriptionPayload } from 'server-lib-common';
import { getPushServiceWorkerRegistration } from '../pocket-app/service-worker';

/**
 * Why the user cannot subscribe right now, or `ready` if they can.
 *
 * `needs-install` is the iOS rule: Web Push is granted only to a Home Screen
 * web app, never to a Safari tab. It is a *hint* for the UI, not the gate — the
 * gate is `subscribe()` failing, because only the browser knows for certain.
 */
export type PushAvailability =
  | 'ready'
  | 'unsupported'
  | 'needs-install'
  | 'no-worker'
  | 'denied'
  | 'subscribed';

/**
 * True when the page is running as an installed web app rather than a tab.
 * `navigator.standalone` is the iOS signal; the media query is the standard one.
 */
export function isInstalledWebApp(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  return globalThis.matchMedia?.('(display-mode: standalone)').matches ?? false;
}

/**
 * True on iOS/iPadOS, where Web Push requires a Home Screen install.
 *
 * Detected by the *presence* of the non-standard `navigator.standalone` rather
 * than by parsing a user-agent string, which iPadOS deliberately makes
 * unreliable by reporting as a Mac. The property is iOS/iPadOS Safari only and
 * `undefined` everywhere else — including macOS Safari, where Web Push works in
 * an ordinary tab and no install prompt should ever appear.
 *
 * Note the asymmetry this cannot see through: a tab cannot tell whether the
 * user has *also* installed the app, because the two have separate storage and
 * share no signal. UI copy has to allow for "already installed, wrong window".
 */
export function requiresInstallForPush(): boolean {
  return typeof (navigator as Navigator & { standalone?: boolean }).standalone === 'boolean';
}

export async function getPushAvailability(): Promise<PushAvailability> {
  if (!('serviceWorker' in navigator) || typeof globalThis.Notification !== 'function') {
    return 'unsupported';
  }
  // On iOS the Push API is simply absent outside an installed web app, so this
  // check and the one below can both be the reason — report the actionable one.
  if (requiresInstallForPush() && !isInstalledWebApp()) return 'needs-install';
  if (!('PushManager' in globalThis)) return 'unsupported';

  // Awaited rather than probed: registration is kicked off during boot and may
  // still be in flight, so a bare `getRegistration()` would report a transient
  // null as a failure.
  const registration = await getPushServiceWorkerRegistration();
  if (!registration) return 'no-worker';

  if (Notification.permission === 'denied') return 'denied';
  return (await registration.pushManager.getSubscription()) ? 'subscribed' : 'ready';
}

/**
 * Ask for permission and subscribe. **Must be called from a user gesture** —
 * iOS rejects a permission request that is not, and there is no way to recover
 * from a denial in the same session.
 *
 * Returns the subscription in the shape the Server stores, or throws with a
 * message worth showing.
 */
export async function subscribeToPushInBrowser(
  applicationServerKey: string,
): Promise<PushSubscriptionPayload> {
  // Checked before the permission prompt so a missing worker fails with an
  // explanation rather than after the user has already answered a dialog.
  const registration = await getPushServiceWorkerRegistration();
  if (!registration) {
    throw new Error(
      'Dormouse could not start its background worker, so it cannot receive push. ' +
        'This usually means the server is not being served over https.',
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

  // An existing subscription was minted against whatever key was configured at
  // the time. Reusing one from a rotated VAPID key yields a subscription the
  // server can never sign for, so replace rather than reuse.
  const existing = await registration.pushManager.getSubscription();
  if (existing) await existing.unsubscribe().catch(() => undefined);

  const subscription = await registration.pushManager.subscribe({
    // Mandatory in Chrome and on iOS: a promise that every push we receive
    // becomes a visible notification. `sw.js` keeps it.
    userVisibleOnly: true,
    // Passed as bytes rather than the base64url string: browsers disagree about
    // accepting the string form.
    applicationServerKey: fromBase64Url(applicationServerKey) as BufferSource,
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

/** Drop the local subscription. The server row is pruned when delivery 410s. */
export async function unsubscribeFromPushInBrowser(): Promise<void> {
  const registration = await getPushServiceWorkerRegistration();
  const existing = await registration?.pushManager.getSubscription();
  await existing?.unsubscribe();
}
