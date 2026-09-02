/**
 * Pocket's service worker: a push transport, and deliberately nothing more
 * (`docs/specs/pocket-app.md` -> Installable web app).
 *
 * It registers no `fetch` handler and caches nothing. Pocket is useless without
 * a live relay connection, so an offline cache would buy no working screens
 * while actively fighting the server's SPA-shell handling: `registerPocketServing`
 * re-reads `index.html` per request precisely because a rebuild swaps in new
 * content-hashed assets, and a cached shell would keep pointing at deleted ones.
 *
 * **This is where a push is finally readable.** The Host seals every
 * notification to this Client's own static and the Server forwards ciphertext
 * (`docs/specs/remote-security-model.md` -> Push sealing), so the worker holds
 * the only key that opens one — which is why it is a bundled TypeScript module
 * rather than a hand-copied file, and why it imports the same `openPush` and
 * `boundedPushText` the rest of the system runs. It is built by
 * `lib/vite.sw.config.ts` into one classic IIFE at the stable, unhashed
 * `dist-pocket/sw.js`; `lib/scripts/assert-pocket-worker.mjs` is what holds that
 * shape.
 *
 * The event wiring at the bottom is a thin shell over the functions above it,
 * so the decision table can be driven directly by
 * `lib/src/remote/pocket-app/sw.test.ts`.
 */

import {
  boundedPushText,
  fromBase64Url,
  isE2eId,
  isSealedPushV1,
  openPush,
  utf8Decode,
} from 'server-lib-common';

import { indexedDbKnownHostStore, type KnownHostStore } from '../client/pocket-db';

/**
 * Longest title/body this sink will render. The Host caps the same fields
 * before sealing them; this is the belt to that suspenders, applied where the
 * untrusted string is finally displayed and where — unlike before the seal —
 * it is the *only* remaining boundary, since the Server cannot read what it
 * forwards (`docs/specs/alert.md` -> Push notifications).
 */
const PUSH_TEXT_LIMIT = 200;

/**
 * What a push we cannot read still has to show.
 *
 * Subscribing with `userVisibleOnly: true` promises the browser that every
 * delivery becomes a visible notification; a browser that catches us showing
 * none substitutes its own "this site was updated in the background" notice and
 * counts it against the subscription's budget. So every failure — no payload,
 * an unknown Host, a record that lost its authorization, a decrypt failure,
 * malformed plaintext — lands here rather than returning early.
 */
export const GENERIC_PUSH_NOTIFICATION: PocketNotification = {
  title: 'Dormouse',
  body: 'A terminal needs attention.',
};

/** One notification, already bounded and safe to hand the OS. */
export interface PocketNotification {
  readonly title: string;
  readonly body: string;
  /**
   * Collapse key. The Host tags per Session so a Pane that rings, is cleared,
   * and rings again replaces its own notification instead of stacking copies on
   * the lock screen (`docs/specs/alert.md` -> Push notifications).
   */
  readonly tag?: string;
}

/**
 * Turn one delivered payload into the notification to show.
 *
 * **Never throws and never answers nothing**: its input is whatever a push
 * service handed the browser, and `userVisibleOnly` makes "show nothing" a
 * penalty rather than an option.
 */
export async function notificationForPush(
  payload: unknown,
  store: KnownHostStore,
): Promise<PocketNotification> {
  try {
    return (await openNotification(payload, store)) ?? GENERIC_PUSH_NOTIFICATION;
  } catch {
    return GENERIC_PUSH_NOTIFICATION;
  }
}

/** The readable case, or `null` for every way it can fail to be one. */
async function openNotification(
  payload: unknown,
  store: KnownHostStore,
): Promise<PocketNotification | null> {
  if (!payload || typeof payload !== 'object') return null;
  const envelope = payload as { hostId?: unknown };
  // Bounded before it becomes a database key, and before any crypto runs.
  if (!isE2eId(envelope.hostId) || !isSealedPushV1(payload)) return null;

  const record = await store.get(envelope.hostId);
  // A `pairing-required` record kept its pin but lost its authorization, so it
  // is not a live Client and its Host's pushes are not ours to render — the
  // same "cannot decrypt" as an unknown Host
  // (`docs/specs/remote-security-model.md` -> Connection).
  if (!record || record.authorization.state !== 'paired') return null;

  const plaintext = await openPush({
    clientStaticPrivateKey: record.clientStaticKeyPair.privateKey,
    hostStaticPublicKey: fromBase64Url(record.hostStaticPublicKey),
    sealed: payload,
  });
  if (!plaintext) return null;

  const fields: unknown = JSON.parse(utf8Decode(plaintext));
  if (!fields || typeof fields !== 'object') return null;
  const { title, body, tag } = fields as { title?: unknown; body?: unknown; tag?: unknown };
  // Re-validated and re-bounded at the sink even though the Host bounded it:
  // this text is terminal-supplied, and the Server can no longer be the second
  // pair of eyes it used to be.
  const bounded = (value: unknown, fallback: string) =>
    boundedPushText(value, { limit: PUSH_TEXT_LIMIT, fallback });
  return {
    title: bounded(title, GENERIC_PUSH_NOTIFICATION.title),
    body: bounded(body, GENERIC_PUSH_NOTIFICATION.body),
    // A tag is never displayed, so an empty one is simply no tag rather than a
    // fallback string — collapsing onto a shared literal would make unrelated
    // Sessions replace each other's notifications.
    tag: bounded(tag, '') || undefined,
  };
}

/** Options for one `showNotification` call; the icons are the app's own. */
function notificationOptions(notification: PocketNotification): NotificationOptionsLike {
  return {
    body: notification.body,
    // The tag is what makes a re-ring replace rather than stack; `renotify` is
    // left at its default so replacing does not buzz the phone again.
    tag: notification.tag,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
  };
}

/**
 * Wire this worker's four handlers onto `scope`.
 *
 * Takes its scope and store as arguments so the same code a phone runs is the
 * code the tests drive; the module-level call at the bottom is the only place
 * the real globals are named.
 */
export function installPocketWorker(scope: WorkerScope, store: KnownHostStore): void {
  scope.addEventListener('install', () => {
    // Nothing to precache, so there is no reason to wait for the old worker.
    scope.skipWaiting();
  });

  scope.addEventListener('activate', (event) => {
    event.waitUntil(scope.clients.claim());
  });

  scope.addEventListener('push', (event) => {
    // Read inside the handler's own guard: `json()` throws on a body that is
    // not JSON, and a throw here would be a delivery with no notification.
    let payload: unknown = null;
    try {
      payload = event.data ? event.data.json() : null;
    } catch {
      payload = null;
    }
    event.waitUntil(
      notificationForPush(payload, store).then((notification) =>
        scope.registration.showNotification(notification.title, notificationOptions(notification)),
      ),
    );
  });

  scope.addEventListener('notificationclick', (event) => {
    event.notification.close();
    // Pocket has no deep link to an individual Pane, so this focuses the app and
    // leaves the user on the directory. Opening the right Pane needs a routable
    // surface ref, which protocol-v1 does not carry.
    event.waitUntil(
      scope.clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then((windows) => {
          for (const client of windows) {
            if (client.focus) return client.focus();
          }
          return scope.clients.openWindow('/');
        }),
    );
  });
}

// ---------------------------------------------------------------------------
// The slice of `ServiceWorkerGlobalScope` this worker uses. Declared rather
// than imported: `lib.webworker.d.ts` cannot be loaded beside `lib.dom.d.ts`,
// which the rest of `lib/src` needs, and a fake scope in a test satisfies these
// structurally.

interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

interface PushEventLike extends ExtendableEventLike {
  readonly data?: { json(): unknown } | null;
}

interface NotificationClickEventLike extends ExtendableEventLike {
  readonly notification: { close(): void };
}

interface WindowClientLike {
  focus?: () => Promise<unknown>;
}

interface NotificationOptionsLike {
  body: string;
  tag?: string;
  icon: string;
  badge: string;
}

export interface WorkerScope {
  addEventListener(type: 'install', listener: () => void): void;
  addEventListener(type: 'activate', listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: 'push', listener: (event: PushEventLike) => void): void;
  addEventListener(
    type: 'notificationclick',
    listener: (event: NotificationClickEventLike) => void,
  ): void;
  skipWaiting(): void;
  readonly clients: {
    claim(): Promise<void>;
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
  readonly registration: {
    showNotification(title: string, options: NotificationOptionsLike): Promise<void>;
  };
}

// A real worker global has both of these and a test importing this module has
// neither, so importing the pure functions above installs no listeners.
const globalScope = globalThis as unknown as Partial<WorkerScope>;
if (typeof globalScope.skipWaiting === 'function' && globalScope.registration) {
  installPocketWorker(globalScope as WorkerScope, indexedDbKnownHostStore());
}
