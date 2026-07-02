/**
 * Slice-1 sign-in coverage (docs/specs/server.md): passkey assertions minted by
 * the harness `SimAuthenticator`, single-use sign-in challenges, session minting
 * and expiry, and the `requireSession` gate slice 2 will hang `/api/hosts` off.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Hono } from 'hono';
import { API_ROUTES } from 'server-lib-common';
import { SimAuthenticator } from '../../server-lib-common/test/harness/actors.mjs';

import { freshApp, makeClock, newAuthenticator, post, register, signin } from './helpers.mjs';

test('sign-in happy path mints a session the store accepts', async () => {
  const { app, sessions } = await freshApp();
  const authenticator = await newAuthenticator();
  assert.equal((await register(app, authenticator)).status, 200);

  const { res } = await signin(app, authenticator);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.accountId, 'owner');
  assert.equal(typeof body.sessionToken, 'string');
  assert.equal(typeof body.expiresAt, 'number');

  const session = sessions.validate(body.sessionToken);
  assert.ok(session);
  assert.equal(session.accountId, 'owner');
  assert.equal(sessions.validate('not-a-real-token'), null);
});

test('sign-in rejects an unknown credential', async () => {
  const { app } = await freshApp();
  assert.equal((await register(app, await newAuthenticator())).status, 200);

  // A different, never-registered authenticator.
  const stranger = await newAuthenticator();
  const { res } = await signin(app, stranger);
  assert.equal(res.status, 404);
});

test('sign-in rejects a replayed challenge/assertion', async () => {
  const { app } = await freshApp();
  const authenticator = await newAuthenticator();
  assert.equal((await register(app, authenticator)).status, 200);

  const { res, assertion } = await signin(app, authenticator);
  assert.equal(res.status, 200);

  // Same assertion again — its challenge was consumed on the first finish.
  const replay = await post(app, API_ROUTES.signinFinish, { assertion });
  assert.equal(replay.status, 400);
  assert.match((await replay.json()).error, /challenge/);
});

test('sign-in rejects a tampered signature', async () => {
  const { app } = await freshApp();
  const authenticator = await newAuthenticator();
  assert.equal((await register(app, authenticator)).status, 200);

  // Sign the assertion with a foreign key: valid shape, invalid signature.
  const signWith = await SimAuthenticator.foreignSigningKey();
  const { res } = await signin(app, authenticator, { tamper: { signWith } });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /signature/);
});

test('sign-in rejects an assertion for a foreign origin', async () => {
  const { app } = await freshApp();
  const authenticator = await newAuthenticator();
  assert.equal((await register(app, authenticator)).status, 200);

  const { res } = await signin(app, authenticator, { tamper: { origin: 'http://evil.example' } });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /origin/);
});

test('an expired session token no longer validates', async () => {
  const clock = makeClock();
  const { app, sessions } = await freshApp({ now: clock.now });
  const authenticator = await newAuthenticator();
  assert.equal((await register(app, authenticator)).status, 200);

  const { res } = await signin(app, authenticator);
  const { sessionToken } = await res.json();
  assert.ok(sessions.validate(sessionToken));

  clock.advance(12 * 60 * 60 * 1000 + 1); // past the 12h TTL
  assert.equal(sessions.validate(sessionToken), null);
});

test('requireSession gates a route on the Bearer token', async () => {
  const { app, sessions, requireSession } = await freshApp();
  const authenticator = await newAuthenticator();
  assert.equal((await register(app, authenticator)).status, 200);
  const { res } = await signin(app, authenticator);
  const { sessionToken } = await res.json();

  // Mount the exported middleware on a throwaway route to exercise it directly.
  const probe = new Hono();
  probe.get('/probe', requireSession, (c) => c.json({ accountId: c.get('session').accountId }));

  const withToken = await probe.request('/probe', {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(withToken.status, 200);
  assert.deepEqual(await withToken.json(), { accountId: 'owner' });

  assert.equal((await probe.request('/probe')).status, 401);
  assert.equal(
    (await probe.request('/probe', { headers: { Authorization: 'Bearer nope' } })).status,
    401,
  );
  // Sanity: the store still recognizes the live token.
  assert.ok(sessions.validate(sessionToken));
});
