/** Shared Relay startup. Production owns its listener; dev can supply an already
 * bound HTTP server so its origin is known before constructing the app. */
import { getRequestListener, serve } from '@hono/node-server';

import { createApp, BURROW_REVOCATION_SWEEP_MS, RELAY_SWEEP_MS } from './app.js';
import type { RelayConfig } from './config.js';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  assertVapidKeyPair,
  assertVapidSubject,
  createWebPushSender,
  generateVapidKeys,
} from './push.js';
import { removeRuntimeFile, writeRuntimeFile } from './runtime-file.js';
import { generateSetupPassword } from './setup-password.js';
import {
  CorruptStateError,
  forgetRetiredState,
  SetupPasswordStore,
  VapidStore,
} from './state.js';

export async function startRelay(config: RelayConfig, existingServer?: Server) {
  const { port, bindHost, vapidKeys, vapidSubject, runtimeFile, releaseId, ...appConfig } =
    config;
  const { origin, stateDir } = appConfig;

  /**
   * The two records the Relay mints for itself. Two independent state files, so
   * one round of I/O rather than two before the port is bound: enrollment's
   * bootstrap credential is Relay state, never configuration an operator can
   * weaken, and the VAPID keypair is the one part of that story which is not a
   * pure env read. Each is minted once and persisted through its store's
   * owner-only atomic write.
   *
   * A corrupt record stops the boot rather than being minted over, so this exits
   * the way a bad `DORMOUSE_VAPID_*` pair does instead of as an unhandled
   * rejection — the repair is the operator's to choose, and both directions cost
   * something: replacing the setup password re-enrolls every Burrow, replacing the
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
        console.error(`Corrupt Relay state: ${err.message}`);
        console.error(`Restore a good copy of ${err.path}, or delete it to mint a replacement.`);
        process.exit(1);
      }
      throw err;
    }
  }

  // Whatever the Host→Burrow rename stranded in the state dir, deleted unread.
  // Nothing waits on it: it removes a file no code reads (`state.ts`).
  void forgetRetiredState(stateDir);

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

  const { app, injectWebSocket, sweepRevokedBurrows, sweepRelaySockets } = createApp({
    ...appConfig,
    setupPassword,
    // Both together or neither: advertising a key the Relay has no subject to
    // sign with would let a phone register against a push it can never receive.
    ...(vapidSubject === null
      ? {}
      : {
          vapidPublicKey: vapid.publicKey,
          pushSender: createWebPushSender(vapid, vapidSubject),
        }),
  });

  // The socket's own port, never the configured one: with a caller-supplied
  // server `port` was only ever a request, and this line and the runtime file
  // are what a reader and an installer believe.
  const announce = (listening: Server) => {
    const boundPort = (listening.address() as AddressInfo).port;
    console.log(
      `relay listening on http://${bindHost ?? 'localhost'}:${boundPort} (origin ${origin})`,
    );
    // Only now, with the port actually taken: this file is what tells an
    // installer which release is answering, and claiming it before the bind
    // succeeded would be the very confusion it exists to remove. Never fatal —
    // an unwritten identity degrades the installer to "unknown", which it
    // handles, where a crash here would take down a working Relay.
    if (runtimeFile !== null) {
      void writeRuntimeFile(runtimeFile, {
        pid: process.pid,
        releaseId,
        port: boundPort,
        origin,
        startedAt: new Date().toISOString(),
      }).catch((err: unknown) => {
        console.warn(
          `could not write ${runtimeFile}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  };
  // `hostname` is omitted rather than passed as undefined so @hono/node-server
  // keeps its listen-on-every-interface default (what a container wants). The
  // caller-supplied branch mirrors what `serve` does internally — including
  // handing `hostname` to `getRequestListener`, which is the Host fallback for a
  // request that carries no Host header — so the two paths cannot drift.
  let server: Server;
  if (existingServer) {
    existingServer.on('request', getRequestListener(app.fetch, { hostname: bindHost }));
    server = existingServer;
    announce(server);
  } else {
    server = serve(
      { fetch: app.fetch, port, ...(bindHost ? { hostname: bindHost } : {}) },
      () => announce(server),
    ) as Server;
  }

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

  // Bind the relay's WS upgrade handler onto the running HTTP server (@hono/node-ws).
  injectWebSocket(server);

  // Revocation is hand-editing `burrows.json`, and the `/ws/burrow` token is checked
  // only at the upgrade, so a connected Burrow has to be re-checked on a clock
  // (`docs/specs/relay.md` -> Guardrails). `unref`'d: nothing here is work the
  // Relay owes anyone, so it must not be a reason the process stays alive.
  setInterval(() => {
    void sweepRevokedBurrows().catch(() => {
      // A `burrows.json` caught mid-edit is an expected state (State files); the
      // next sweep reads it again.
    });
  }, BURROW_REVOCATION_SWEEP_MS).unref();

  // The socket-level sweep, on the same terms and for the same reason: the
  // `/ws/client` session is checked once at the upgrade, and a half-open TCP
  // connection closes nothing on its own (`docs/specs/relay.md` -> "Routing"). It
  // touches no disk, so it runs far more often and cannot throw.
  setInterval(() => {
    sweepRelaySockets();
  }, RELAY_SWEEP_MS).unref();
}
