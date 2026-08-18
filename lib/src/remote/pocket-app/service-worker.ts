/**
 * Service worker registration for Pocket (docs/specs/pocket-app.md ->
 * Installable web app).
 *
 * The worker exists only so the app can receive Web Push while backgrounded or
 * closed; it caches nothing. Registration is therefore best-effort — every
 * screen in Pocket works without it, so a failure warns and moves on rather
 * than blocking boot.
 *
 * Failure is expected in three ordinary situations: a browser with no service
 * worker support, an insecure origin (service workers need a secure context, and
 * only `localhost` is exempt), and a dev build served from somewhere other than
 * the app's own origin.
 */

/** Registered at the root so one worker covers the whole single-page app. */
const SERVICE_WORKER_URL = '/sw.js';

/**
 * The in-flight or settled registration, `null` if it failed or was never
 * attempted. Held so the subscribe path can await *this* rather than
 * `navigator.serviceWorker.ready`, which never settles when registration
 * failed — that would hang the button the user just tapped with no way out.
 */
let registration: Promise<ServiceWorkerRegistration | null> = Promise.resolve(null);

export function registerPushServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  registration = navigator.serviceWorker
    .register(SERVICE_WORKER_URL, { scope: '/' })
    .catch((error: unknown) => {
      // Loud but not fatal: without this, "push silently never arrives" has no
      // visible cause anywhere in the app.
      console.warn('pocket: service worker registration failed; push is unavailable', error);
      return null;
    });
}

/**
 * The registered worker, or `null` if registration failed. Resolves once
 * registration settles, so a caller can never observe a half-registered state.
 */
export function getPushServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  return registration;
}
