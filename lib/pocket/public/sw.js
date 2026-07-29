/**
 * Pocket's service worker: a push transport, and deliberately nothing more
 * (docs/specs/pocket-app.md -> Installable web app).
 *
 * It registers no `fetch` handler and caches nothing. Pocket is useless without
 * a live relay connection, so an offline cache would buy no working screens
 * while actively fighting the server's SPA-shell handling: `registerPocketServing`
 * re-reads `index.html` per request precisely because a rebuild swaps in new
 * content-hashed assets, and a cached shell would keep pointing at deleted ones.
 *
 * It lives in `public/` rather than the bundle so Vite copies it verbatim: a
 * service worker has to be served from the scope it controls, under a stable
 * path, with no content hash in its name.
 */

/**
 * Longest title/body we will render. A push payload is derived from a Pane
 * label, which has no useful upper bound, and the Host already caps it — this
 * is the belt to that suspenders, applied where the untrusted string is finally
 * displayed.
 */
const TEXT_LIMIT = 200;

/**
 * A push we cannot read still has to show something. Subscribing with
 * `userVisibleOnly: true` promises the browser that every delivery becomes a
 * visible notification; a browser that catches us showing none substitutes its
 * own "this site was updated in the background" notice and counts it against
 * the subscription's budget.
 */
const FALLBACK_TITLE = 'Dormouse';
const FALLBACK_BODY = 'A terminal needs attention.';

/**
 * Coerce an untrusted payload field to a bounded, single-line string.
 * Mirrors `boundedPushText` in server-lib-common; this classic worker is copied
 * verbatim and cannot import that implementation.
 */
function text(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const cleaned = value
    // C0, DEL, and C1 control characters.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    // Zero-width and joiner characters, bidi embedding/override marks, bidi
    // isolates, and the BOM.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEXT_LIMIT)
    .trim();
  return cleaned || fallback;
}

function readPayload(event) {
  let parsed;
  try {
    parsed = event.data ? event.data.json() : null;
  } catch {
    // Not JSON — surface whatever text arrived rather than dropping the alarm.
    parsed = { body: event.data.text() };
  }
  // `text()` already falls back for anything that is not a usable string, so
  // absent, non-object, and malformed payloads all land here the same way.
  return {
    title: text(parsed?.title, FALLBACK_TITLE),
    body: text(parsed?.body, FALLBACK_BODY),
    // The Host tags per Session so a Pane that rings, is cleared, and rings
    // again replaces its own notification instead of stacking copies on the
    // lock screen (docs/specs/alert.md -> Push notifications).
    tag: typeof parsed?.tag === 'string' && parsed.tag ? parsed.tag : undefined,
  };
}

self.addEventListener('install', () => {
  // Nothing to precache, so there is no reason to wait for the old worker.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  const { title, body, tag } = readPayload(event);
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      // The tag is what makes a re-ring replace rather than stack; `renotify`
      // is left at its default so replacing does not buzz the phone again.
      tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Pocket has no deep link to an individual Pane, so this focuses the app and
  // leaves the user on the directory. Opening the right Pane needs a routable
  // surface ref, which protocol-v1 does not carry.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});
