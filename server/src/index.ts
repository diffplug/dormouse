/**
 * Process entrypoint: translate environment variables (docs/specs/server.md,
 * "Configuration") into an {@link AppConfig} and bind a port. Kept separate from
 * `app.ts` so the app itself stays testable without touching env or the network.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import {
  assertVapidKeyPair,
  assertVapidSubject,
  createWebPushSender,
  defaultVapidSubject,
  generateVapidKeys,
} from './push.js';
import { VapidStore } from './state.js';

const port = Number(process.env.PORT ?? 3000);

const setupPassword = process.env.DORMOUSE_SETUP_PASSWORD;
if (!setupPassword) {
  console.error(
    'DORMOUSE_SETUP_PASSWORD is required — it gates account creation and host enrollment.',
  );
  process.exit(1);
}

const origin = process.env.DORMOUSE_ORIGIN ?? `http://localhost:${port}`;
const stateDir = process.env.DORMOUSE_STATE_DIR ?? './data';

// Default to `lib/dist-pocket` resolved from this compiled file's location
// (server/dist/index.js → repo root two levels up), so it works regardless of
// the process's cwd. Override with DORMOUSE_POCKET_DIR.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pocketDir = process.env.DORMOUSE_POCKET_DIR ?? join(repoRoot, 'lib', 'dist-pocket');

// VAPID keys sign the push JWT and identify this server to every push service.
// Supply both through env to control them; supply neither and the server mints
// a pair once and persists it (0o600), so a selfhost POC needs no key ceremony.
// Supplying exactly one is a misconfiguration, not a default worth guessing at:
// the pair must match or every subscription silently stops working.
const envVapidPublic = process.env.DORMOUSE_VAPID_PUBLIC_KEY;
const envVapidPrivate = process.env.DORMOUSE_VAPID_PRIVATE_KEY;
if (!!envVapidPublic !== !!envVapidPrivate) {
  console.error(
    'DORMOUSE_VAPID_PUBLIC_KEY and DORMOUSE_VAPID_PRIVATE_KEY must be set together, or neither.',
  );
  process.exit(1);
}
const vapid =
  envVapidPublic && envVapidPrivate
    ? { publicKey: envVapidPublic, privateKey: envVapidPrivate }
    : await new VapidStore(stateDir).loadOrCreate(generateVapidKeys);
// The JWT is signed with an operator contact, so no subject means no push at
// all — `web-push` cannot construct a send without one. An unset
// DORMOUSE_VAPID_SUBJECT therefore falls back to this server's own origin,
// which is unusable only for a loopback dev server. There push is switched off
// rather than left half-working: a phone cannot route to localhost anyway, and
// booting with a subject a push service rejects is what made every iPhone
// delivery fail silently before.
const vapidSubject = process.env.DORMOUSE_VAPID_SUBJECT ?? defaultVapidSubject(origin);
try {
  assertVapidKeyPair(vapid);
  if (vapidSubject !== null) assertVapidSubject(vapidSubject);
} catch (err) {
  console.error(`Invalid VAPID configuration: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (vapidSubject === null) {
  console.warn(
    `push is disabled: no VAPID subject. DORMOUSE_ORIGIN (${origin}) cannot serve as one — ` +
      'set DORMOUSE_VAPID_SUBJECT to a routable mailto: or https: contact to enable it.',
  );
}

const { app, injectWebSocket } = createApp({
  setupPassword,
  origin,
  stateDir,
  pocketDir,
  // Both together or neither: advertising a key the server has no subject to
  // sign with would let a phone register against a push it can never receive.
  ...(vapidSubject === null
    ? {}
    : {
        vapidPublicKey: vapid.publicKey,
        pushSender: createWebPushSender(vapid, vapidSubject),
      }),
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server listening on http://localhost:${info.port} (origin ${origin})`);
});

// Bind the relay's WS upgrade handler onto the running server (@hono/node-ws).
injectWebSocket(server);
