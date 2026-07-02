/**
 * Shared scaffolding for the slice-1 server tests. Each test gets a fresh temp
 * state dir and its own `createApp`, so cases never share account.json,
 * challenge stores, or sessions. Real WebAuthn is produced by `SimAuthenticator`
 * from the server-lib-common harness — no browser required.
 */

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serve } from '@hono/node-server';
import { API_ROUTES, WS_ROUTES, WS_TOKEN_PARAM, toBase64Url, utf8Encode } from 'server-lib-common';

import { createApp } from '../dist/app.js';
import { SimAuthenticator } from '../../server-lib-common/test/harness/actors.mjs';

export const ORIGIN = 'http://localhost:3000';
export const RP_ID = 'localhost';
export const PASSWORD = 'correct horse battery staple';

/** A manually-advanced clock for TTL/expiry tests. */
export function makeClock(startMs = 1_700_000_000_000) {
  let ms = startMs;
  return {
    now: () => ms,
    advance(delta) {
      ms += delta;
    },
  };
}

export async function freshApp({ password = PASSWORD, origin = ORIGIN, now } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'dormouse-server-'));
  const created = createApp({ setupPassword: password, origin, stateDir, now });
  return { ...created, stateDir, origin, rpId: new URL(origin).hostname };
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

/** begin → finish registration for `authenticator`; returns the finish Response. */
export async function register(
  app,
  authenticator,
  { password = PASSWORD, origin = ORIGIN, label = 'Test Passkey' } = {},
) {
  const begin = await post(app, API_ROUTES.setupBegin, { password });
  const { challenge } = await begin.json();
  const clientDataJSON = registrationClientData({ challenge, origin });
  return post(app, API_ROUTES.setupFinish, {
    password,
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

// --- Slice 2: live server + WebSocket relay scaffolding --------------------

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
 * `wsUrl` is ready for `/ws/host` / `/ws/client`.
 */
/** Every {@link wsConnect} socket, so a server teardown can force them shut. */
const OPEN_SOCKETS = new Set();

export function startServer(created) {
  return new Promise((resolve) => {
    const server = serve({ fetch: created.app.fetch, port: 0 }, (info) => {
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

/** POST /api/host/enroll with the setup password; returns the JSON body. */
export async function enrollHost(app, { label = 'Laptop', password = PASSWORD } = {}) {
  const res = await post(app, API_ROUTES.hostEnroll, { password, label });
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

/** Enroll a host and open its `/ws/host` socket (awaiting the upgrade). */
export async function connectHost(app, server, opts) {
  const { body } = await enrollHost(app, opts);
  const socket = wsConnect(`${server.wsUrl}${WS_ROUTES.host}?${WS_TOKEN_PARAM}=${body.hostToken}`);
  await socket.ready;
  return { host: body, socket };
}

/** Register+sign-in an owner and open a `/ws/client` socket (awaiting the upgrade). */
export async function connectClient(app, server) {
  const { sessionToken, authenticator } = await ownerSession(app);
  const socket = wsConnect(`${server.wsUrl}${WS_ROUTES.client}?${WS_TOKEN_PARAM}=${sessionToken}`);
  await socket.ready;
  return { sessionToken, authenticator, socket };
}
