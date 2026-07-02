/**
 * Shared scaffolding for the slice-1 server tests. Each test gets a fresh temp
 * state dir and its own `createApp`, so cases never share account.json,
 * challenge stores, or sessions. Real WebAuthn is produced by `SimAuthenticator`
 * from the server-lib-common harness — no browser required.
 */

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { API_ROUTES, toBase64Url, utf8Encode } from 'server-lib-common';

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
