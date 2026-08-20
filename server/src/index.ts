/**
 * Process entrypoint: read the environment via {@link readConfig}, resolve the
 * VAPID keypair (which touches disk, so it stays here rather than in the pure
 * config mapping), and bind a port. Kept separate from `app.ts` so the app
 * itself stays testable without touching env or the network.
 */

import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { ConfigError, readConfig } from './config.js';
import {
  assertVapidKeyPair,
  assertVapidSubject,
  createWebPushSender,
  generateVapidKeys,
} from './push.js';
import { VapidStore } from './state.js';

function loadConfig() {
  try {
    return readConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

const { port, bindHost, vapidKeys, vapidSubject, ...appConfig } = loadConfig();
const { origin, stateDir } = appConfig;

// The one part of the VAPID story that is not a pure env read: with no keys
// configured, mint a pair once and persist it (0o600).
const vapid = vapidKeys ?? (await new VapidStore(stateDir).loadOrCreate(generateVapidKeys));
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
  ...appConfig,
  // Both together or neither: advertising a key the server has no subject to
  // sign with would let a phone register against a push it can never receive.
  ...(vapidSubject === null
    ? {}
    : {
        vapidPublicKey: vapid.publicKey,
        pushSender: createWebPushSender(vapid, vapidSubject),
      }),
});

// `hostname` is omitted rather than passed as undefined so @hono/node-server
// keeps its listen-on-every-interface default (what a container wants).
const server = serve(
  { fetch: app.fetch, port, ...(bindHost ? { hostname: bindHost } : {}) },
  (info) => {
    console.log(
      `server listening on http://${bindHost ?? 'localhost'}:${info.port} (origin ${origin})`,
    );
  },
);

// Bind the relay's WS upgrade handler onto the running server (@hono/node-ws).
injectWebSocket(server);
