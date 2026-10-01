/**
 * Shared scaffolding for the slice-1 Relay tests. Each test gets a fresh temp
 * state dir and its own `createApp`, so cases never share account.json,
 * challenge stores, or sessions. Real WebAuthn is produced by `SimAuthenticator`
 * from the remote-lib-common harness — no browser required.
 */

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serve } from '@hono/node-server';
import { API_ROUTES, WS_ROUTES, WS_TOKEN_PARAM } from 'remote-lib-common';

import { createApp } from '../dist/app.js';
import {
  SimAuthenticator,
  registrationClientData as browserRegistrationClientData,
} from '../../remote-lib-common/test/harness/actors.mjs';
import { openFrameSocket } from '../../remote-lib-common/test/harness/frame-socket.mjs';
import { ORIGIN, PASSWORD, RP_ID } from './fixtures.mjs';

export * from './fixtures.mjs';
export { makeClock } from '../../remote-lib-common/test/harness/clock.mjs';
export { sleep, until } from '../../remote-lib-common/test/harness/frame-socket.mjs';

/**
 * No app here pays the real `CREDENTIAL_FAILURE_DELAY_MS`: a suite full of 401s
 * would spend its wall time asleep. The one test that measures the delay
 * injects its own wait.
 */
const NO_CREDENTIAL_FAILURE_DELAY = async () => {};

export async function freshApp({
  password = PASSWORD,
  origin = ORIGIN,
  now,
  requireUserVerification,
  vapidPublicKey,
  pushSender,
  // Forwarded, or a wedged-push-service case waits out the real 15-second
  // deadline it is meant to be proving.
  pushSendDeadlineMs,
  enrollTokenFile,
  credentialFailureDelay = NO_CREDENTIAL_FAILURE_DELAY,
} = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'dormouse-relay-'));
  const created = createApp({
    setupPassword: password,
    origin,
    stateDir,
    now,
    requireUserVerification,
    vapidPublicKey,
    pushSender,
    pushSendDeadlineMs,
    enrollTokenFile,
    credentialFailureDelay,
  });
  return { ...created, stateDir, origin, rpId: new URL(origin).hostname };
}

/**
 * A {@link PushSender} that records instead of sending. `expire` / `fail` name
 * endpoints that should report those outcomes, and `hang` names one that never
 * settles, so the pruning, counting, and deadline paths are all testable
 * without a real push service.
 */
export function fakePushSender() {
  const sent = [];
  const expired = new Set();
  const failing = new Set();
  const hanging = new Set();
  return {
    sent,
    expire: (endpoint) => expired.add(endpoint),
    fail: (endpoint) => failing.add(endpoint),
    /** Models a push service that accepts the connection and then goes quiet. */
    hang: (endpoint) => hanging.add(endpoint),
    async send(target, payload) {
      sent.push({ endpoint: target.endpoint, keys: target.keys, payload });
      if (hanging.has(target.endpoint)) return new Promise(() => {});
      if (expired.has(target.endpoint)) return 'expired';
      if (failing.has(target.endpoint)) return 'failed';
      return 'delivered';
    },
  };
}

export function post(app, path, body) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

export async function readAccount(stateDir) {
  return JSON.parse(await readFile(join(stateDir, 'account.json'), 'utf8'));
}

export function newAuthenticator() {
  return SimAuthenticator.create({ rpId: RP_ID });
}

/** The shared harness's registration clientDataJSON, from this suite's `ORIGIN` unless named. */
export function registrationClientData({ origin = ORIGIN, ...rest }) {
  return browserRegistrationClientData({ origin, ...rest });
}

/** Serialize an unpadded base64url challenge the way some browsers do in clientDataJSON. */
export function padBase64Url(text) {
  const rem = text.length % 4;
  return rem === 0 ? text : `${text}${'='.repeat(4 - rem)}`;
}

/**
 * Enroll a throwaway Burrow and mint one setup token from it — the only credential
 * `/api/setup/*` takes, so every registration in this suite starts at a code an
 * enrolled Burrow displayed. Pass `burrow` to mint another from one already enrolled.
 */
export async function mintSetupToken(app, burrow) {
  const minter = burrow ?? (await enrollBurrow(app)).body;
  const res = await app.request(API_ROUTES.burrowSetupToken, {
    method: 'POST',
    headers: { authorization: `Bearer ${minter.burrowToken}` },
  });
  const { token } = await res.json();
  return { token, burrow: minter };
}

/**
 * begin → finish registration for `authenticator`; returns the finish Response.
 * `credential` is `{ setupToken }`, freshly minted through a Burrow unless the
 * caller supplies one it wants to control (spent, revoked minter, reused).
 */
export async function register(app, authenticator, options = {}) {
  const { origin = ORIGIN, label = 'Test Passkey' } = options;
  const credential = options.credential ?? { setupToken: (await mintSetupToken(app)).token };
  const begin = await post(app, API_ROUTES.setupBegin, credential);
  if (begin.status !== 200) return begin;
  const { challenge } = await begin.json();
  const clientDataJSON = registrationClientData({ challenge, origin });
  return post(app, API_ROUTES.setupFinish, {
    ...credential,
    credentialId: authenticator.credentialId,
    publicKey: authenticator.publicKey,
    clientDataJSON,
    label,
  });
}

/** begin → assert → finish sign-in for `authenticator`; returns the finish Response. */
export async function signin(app, authenticator, { origin = ORIGIN, rpId = RP_ID, tamper } = {}) {
  const begin = await post(app, API_ROUTES.signinBegin, {});
  const { challenge } = await begin.json();
  const assertion = await authenticator.assert({ challenge, origin, rpId, tamper });
  const res = await post(app, API_ROUTES.signinFinish, { assertion });
  return { res, assertion };
}

// --- Slice 2: live Relay + WebSocket relay scaffolding --------------------

/**
 * Boot a real listening server for a `createApp` result (WS needs a socket, not
 * `app.request`). Binds port 0 and reports the OS-assigned port; the returned
 * `wsUrl` is ready for `/ws/burrow` / `/ws/client`.
 */
/** Every {@link wsConnect} socket, so a Relay teardown can force them shut. */
const OPEN_SOCKETS = new Set();

export function startRelay(created) {
  return new Promise((resolve) => {
    // Loopback: these are built with the checked-in `PASSWORD` from
    // `fixtures.mjs`, and a test suite must not publish one.
    const server = serve({ fetch: created.app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
      created.injectWebSocket(server);
      resolve({
        server,
        port: info.port,
        wsUrl: `ws://localhost:${info.port}`,
        // An http server waits on its live connections, and an *upgraded* WS
        // socket is no longer one it tracks — so close the client ends we know
        // about and resolve on the drain callback OR a short fallback, never
        // hanging teardown.
        close: () =>
          new Promise((res) => {
            for (const ws of OPEN_SOCKETS) {
              try {
                ws.close();
              } catch {
                /* already closing */
              }
            }
            let done = false;
            const finish = () => {
              if (!done) {
                done = true;
                res();
              }
            };
            server.close(finish);
            server.closeAllConnections?.();
            setTimeout(finish, 300).unref();
          }),
      });
    });
  });
}

/** {@link openFrameSocket}, tracked so a Relay teardown can force it shut. */
export function wsConnect(url) {
  const socket = openFrameSocket(url);
  OPEN_SOCKETS.add(socket.ws);
  socket.ws.addEventListener('close', () => OPEN_SOCKETS.delete(socket.ws));
  return socket;
}

/** POST /api/burrow/enroll with the setup password; returns the JSON body. */
export async function enrollBurrow(app) {
  const res = await post(app, API_ROUTES.burrowEnroll, { password: PASSWORD });
  return { res, body: await res.json() };
}

/** Register a fresh passkey and sign in; returns the live session token. */
export async function ownerSession(app) {
  const authenticator = await newAuthenticator();
  await register(app, authenticator);
  const { res } = await signin(app, authenticator);
  const { sessionToken } = await res.json();
  return { authenticator, sessionToken };
}

/** Enroll a burrow and open its `/ws/burrow` socket (awaiting the upgrade). */
export async function connectBurrow(app, server) {
  const { body } = await enrollBurrow(app);
  const socket = wsConnect(`${server.wsUrl}${WS_ROUTES.burrow}?${WS_TOKEN_PARAM}=${body.burrowToken}`);
  await socket.ready;
  return { burrow: body, socket };
}

/** Register+sign-in an owner and open a `/ws/client` socket (awaiting the upgrade). */
export async function connectClient(app, server) {
  const { sessionToken, authenticator } = await ownerSession(app);
  const socket = wsConnect(`${server.wsUrl}${WS_ROUTES.client}?${WS_TOKEN_PARAM}=${sessionToken}`);
  await socket.ready;
  return { sessionToken, authenticator, socket };
}
