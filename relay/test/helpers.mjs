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
import { API_ROUTES, WS_ROUTES, WS_TOKEN_PARAM, toBase64Url, utf8Encode } from 'remote-lib-common';

import { createApp } from '../dist/app.js';
import { SimAuthenticator } from '../../remote-lib-common/test/harness/actors.mjs';
import { ORIGIN, PASSWORD, RP_ID } from './fixtures.mjs';

export * from './fixtures.mjs';
export { makeClock } from '../../remote-lib-common/test/harness/clock.mjs';

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

/** Build registration clientDataJSON exactly as a browser would (webauthn.create). */
export function registrationClientData({ challenge, origin = ORIGIN, type = 'webauthn.create' }) {
  return toBase64Url(utf8Encode(JSON.stringify({ type, challenge, origin, crossOrigin: false })));
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

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `fn` until it returns truthy, or throw after `timeout`ms. */
export async function until(fn, { timeout = 1000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(interval);
  }
}

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

/**
 * Open a WebSocket and wrap it in a tiny test harness: `ready` resolves on open
 * (rejects on a failed upgrade), `take()` yields received frames in order with
 * an internal cursor, and `quiet()` asserts no frame arrived in a window.
 */
export function wsConnect(url) {
  const ws = new WebSocket(url);
  OPEN_SOCKETS.add(ws);
  ws.addEventListener('close', () => OPEN_SOCKETS.delete(ws));
  const messages = [];
  let cursor = 0;
  ws.addEventListener('message', (ev) => {
    messages.push(JSON.parse(typeof ev.data === 'string' ? ev.data : ''));
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (ev) => reject(ev.error ?? new Error('ws error')));
    ws.addEventListener('close', (ev) => reject(new Error(`closed before open (${ev.code})`)));
  });
  const closed = new Promise((resolve) => ws.addEventListener('close', (ev) => resolve(ev)));
  return {
    ws,
    ready,
    closed,
    messages,
    send: (frame) => ws.send(JSON.stringify(frame)),
    close: () => ws.close(),
    /** Next unconsumed frame, waiting up to `timeout`ms for it to arrive. */
    async take(timeout = 1000) {
      await until(() => messages.length > cursor, { timeout });
      return messages[cursor++];
    },
    /** True if no new frame arrives within `ms` (i.e. the pipe stayed blocked). */
    async quiet(ms = 60) {
      const before = messages.length;
      await sleep(ms);
      return messages.length === before;
    },
  };
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
