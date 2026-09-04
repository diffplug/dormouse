/**
 * Process entrypoint: read the environment via {@link readConfig}, resolve the
 * VAPID keypair (which touches disk, so it stays here rather than in the pure
 * config mapping), and bind a port. Kept separate from `app.ts` so the app
 * itself stays testable without touching env or the network.
 */

import { serve } from '@hono/node-server';

import { createApp, HOST_REVOCATION_SWEEP_MS, RELAY_SWEEP_MS } from './app.js';
import { ConfigError, readConfig } from './config.js';
import {
  assertVapidKeyPair,
  assertVapidSubject,
  createWebPushSender,
  generateVapidKeys,
} from './push.js';
import { removeRuntimeFile, writeRuntimeFile } from './runtime-file.js';
import { generateSetupPassword } from './setup-password.js';
import { CorruptStateError, SetupPasswordStore, VapidStore } from './state.js';

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

const { port, bindHost, vapidKeys, vapidSubject, runtimeFile, releaseId, ...appConfig } =
  loadConfig();
const { origin, stateDir } = appConfig;

/**
 * The two records the Server mints for itself. Two independent state files, so
 * one round of I/O rather than two before the port is bound: enrollment's
 * bootstrap credential is server state, never configuration an operator can
 * weaken, and the VAPID keypair is the one part of that story which is not a
 * pure env read. Each is minted once and persisted through its store's
 * owner-only atomic write.
 *
 * A corrupt record stops the boot rather than being minted over, so this exits
 * the way a bad `DORMOUSE_VAPID_*` pair does instead of as an unhandled
 * rejection — the repair is the operator's to choose, and both directions cost
 * something: replacing the setup password re-enrolls every Host, replacing the
 * VAPID keypair invalidates every phone's push subscription.
 */
async function loadMintedState() {
  try {
    return await Promise.all([
      new SetupPasswordStore(stateDir).loadOrCreate(generateSetupPassword),
      vapidKeys ?? new VapidStore(stateDir).loadOrCreate(generateVapidKeys),
    ]);
  } catch (err) {
    if (err instanceof CorruptStateError) {
      console.error(`Corrupt server state: ${err.message}`);
      console.error(`Restore a good copy of ${err.path}, or delete it to mint a replacement.`);
      process.exit(1);
    }
    throw err;
  }
}

const [setupPassword, vapid] = await loadMintedState();
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

const { app, injectWebSocket, sweepRevokedHosts, sweepRelaySockets } = createApp({
  ...appConfig,
  setupPassword,
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
    // Only now, with the port actually taken: this file is what tells an
    // installer which release is answering, and claiming it before the bind
    // succeeded would be the very confusion it exists to remove. Never fatal —
    // an unwritten identity degrades the installer to "unknown", which it
    // handles, where a crash here would take down a working server.
    if (runtimeFile !== null) {
      void writeRuntimeFile(runtimeFile, {
        pid: process.pid,
        releaseId,
        port: info.port,
        origin,
        startedAt: new Date().toISOString(),
      }).catch((err: unknown) => {
        console.warn(
          `could not write ${runtimeFile}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  },
);

// A clean exit takes the file with it. A crash deliberately leaves it: readers
// check whether the recorded pid is alive, so a stale file reads as "nothing is
// serving" rather than as a lie.
if (runtimeFile !== null) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void removeRuntimeFile(runtimeFile).finally(() => process.exit(0));
    });
  }
}

// Bind the relay's WS upgrade handler onto the running server (@hono/node-ws).
injectWebSocket(server);

// Revocation is hand-editing `hosts.json`, and the `/ws/host` token is checked
// only at the upgrade, so a connected Host has to be re-checked on a clock
// (`docs/specs/server.md` -> Guardrails). `unref`'d: nothing here is work the
// server owes anyone, so it must not be a reason the process stays alive.
setInterval(() => {
  void sweepRevokedHosts().catch(() => {
    // A `hosts.json` caught mid-edit is an expected state (State files); the
    // next sweep reads it again.
  });
}, HOST_REVOCATION_SWEEP_MS).unref();

// The socket-level sweep, on the same terms and for the same reason: the
// `/ws/client` session is checked once at the upgrade, and a half-open TCP
// connection closes nothing on its own (`docs/specs/server.md` -> Relay). It
// touches no disk, so it runs far more often and cannot throw.
setInterval(() => {
  sweepRelaySockets();
}, RELAY_SWEEP_MS).unref();
