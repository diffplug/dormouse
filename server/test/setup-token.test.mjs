/**
 * QR-first phone setup, server half (docs/specs/server.md, "HTTP API" and
 * "Relay"): an enrolled Host mints a single-use setup token, a scanning phone
 * redeems it in place of the setup password, and the Host is told when it is
 * spent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { API_ROUTES, UNAUTHORIZED_ERROR } from 'server-lib-common';

import { SetupTokenIssuer, SETUP_TOKEN_TTL_MS } from '../dist/setup-token.js';
import {
  PASSWORD,
  connectHost,
  enrollHost,
  freshApp,
  makeClock,
  newAuthenticator,
  ownerSession,
  post,
  readAccount,
  registrationClientData,
  startServer,
} from './helpers.mjs';

/** `POST /api/host/setup-token` with a host bearer token (no body). */
function mint(app, hostToken) {
  return app.request(API_ROUTES.hostSetupToken, {
    method: 'POST',
    headers: hostToken === undefined ? {} : { Authorization: `Bearer ${hostToken}` },
  });
}

/** An app with one enrolled Host, plus a freshly minted token for it. */
async function appWithToken(options = {}) {
  const created = await freshApp(options);
  const { body: host } = await enrollHost(created.app);
  const res = await mint(created.app, host.hostToken);
  assert.equal(res.status, 200);
  const { token, expiresAt } = await res.json();
  return { ...created, host, token, expiresAt };
}

/** `POST /api/setup/begin` with whatever credential fields are given. */
function begin(app, credential) {
  return post(app, API_ROUTES.setupBegin, credential);
}

/** `POST /api/setup/finish` for `authenticator` under `credential`. */
function finish(app, authenticator, credential, { challenge, label = 'Scanned Phone' } = {}) {
  return post(app, API_ROUTES.setupFinish, {
    ...credential,
    credentialId: authenticator.credentialId,
    publicKey: authenticator.publicKey,
    clientDataJSON: registrationClientData({ challenge }),
    label,
  });
}

/** begin → finish a whole registration under one credential. */
async function registerWith(app, credential, { label } = {}) {
  const authenticator = await newAuthenticator();
  const began = await begin(app, credential);
  if (began.status !== 200) return { began, authenticator };
  const { challenge } = await began.json();
  const finished = await finish(app, authenticator, credential, { challenge, label });
  return { began, authenticator, finished };
}

test('minting requires a host token', async () => {
  const { app } = await freshApp();
  const { body: host } = await enrollHost(app);

  assert.equal((await mint(app, undefined)).status, 401);
  assert.equal((await mint(app, 'not-a-host-token')).status, 401);
  // A signed-in session is the wrong credential: the QR is the Host's to show.
  const { sessionToken } = await ownerSession(app);
  assert.equal((await mint(app, sessionToken)).status, 401);
  const ok = await mint(app, host.hostToken);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(typeof body.token, 'string');
  assert.equal(typeof body.expiresAt, 'number');
});

test('the minted token carries the shared TTL', async () => {
  const clock = makeClock();
  const { expiresAt } = await appWithToken({ now: clock.now });
  assert.equal(expiresAt, clock.now() + SETUP_TOKEN_TTL_MS);
});

test('a scanned token registers a passkey without the setup password', async () => {
  const { app, stateDir, token } = await appWithToken();

  const { began, authenticator, finished } = await registerWith(
    app,
    { setupToken: token },
    { label: 'iPhone Safari' },
  );
  assert.equal(began.status, 200);
  assert.equal(finished.status, 200);
  assert.deepEqual(await finished.json(), {
    accountId: 'owner',
    credentialId: authenticator.credentialId,
  });

  const account = await readAccount(stateDir);
  assert.equal(account.passkeys.length, 1);
  assert.equal(account.passkeys[0].label, 'iPhone Safari');
});

test('the token is single-use: a successful finish spends it', async () => {
  const { app, token } = await appWithToken();
  const { finished } = await registerWith(app, { setupToken: token });
  assert.equal(finished.status, 200);

  // Everything the spent token can still be presented to answers the same way.
  const again = await begin(app, { setupToken: token });
  assert.equal(again.status, 401);
  assert.deepEqual(await again.json(), { error: UNAUTHORIZED_ERROR });
  const authenticator = await newAuthenticator();
  const replay = await finish(app, authenticator, { setupToken: token }, { challenge: 'x' });
  assert.equal(replay.status, 401);
  assert.deepEqual(await replay.json(), { error: UNAUTHORIZED_ERROR });
});

test('begin does not spend the token: an abandoned scan can be retried', async () => {
  const { app, token } = await appWithToken();
  // The user scans, backs out, scans again — the QR on the laptop is still good.
  assert.equal((await begin(app, { setupToken: token })).status, 200);
  const { finished } = await registerWith(app, { setupToken: token });
  assert.equal(finished.status, 200);
});

test('a failed finish leaves the token redeemable', async () => {
  const { app, token } = await appWithToken();
  const first = await newAuthenticator();
  const began = await begin(app, { setupToken: token });
  const { challenge } = await began.json();

  // A finish rejected for its clientData must not cost the user the QR.
  const rejected = await post(app, API_ROUTES.setupFinish, {
    setupToken: token,
    credentialId: first.credentialId,
    publicKey: first.publicKey,
    clientDataJSON: registrationClientData({ challenge, origin: 'http://evil.example' }),
    label: 'x',
  });
  assert.equal(rejected.status, 400);

  const { finished } = await registerWith(app, { setupToken: token });
  assert.equal(finished.status, 200);
});

test('an expired token is refused at begin and at finish', async () => {
  const clock = makeClock();
  const { app, token } = await appWithToken({ now: clock.now });
  // Hold a live registration challenge so the finish case reaches the gate.
  const { challenge } = await (await begin(app, { setupToken: token })).json();

  clock.advance(SETUP_TOKEN_TTL_MS + 1);

  const late = await begin(app, { setupToken: token });
  assert.equal(late.status, 401);
  assert.deepEqual(await late.json(), { error: UNAUTHORIZED_ERROR });

  const authenticator = await newAuthenticator();
  const lateFinish = await finish(app, authenticator, { setupToken: token }, { challenge });
  assert.equal(lateFinish.status, 401);
  assert.deepEqual(await lateFinish.json(), { error: UNAUTHORIZED_ERROR });
});

test('a wrong token answers the shared 401 after the credential delay', async () => {
  const { app } = await appWithToken();
  const started = Date.now();
  const res = await begin(app, { setupToken: 'not-a-minted-token' });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: UNAUTHORIZED_ERROR });
  assert.equal(Date.now() - started >= 200, true);
  // A mistyped credential belongs to that branch, not to the 400 for shape.
  assert.equal((await begin(app, { setupToken: 42 })).status, 401);
});

test('exactly one credential: both or neither is a 400, on both setup routes', async () => {
  const { app, token } = await appWithToken();
  const authenticator = await newAuthenticator();

  for (const credential of [{ password: PASSWORD, setupToken: token }, {}]) {
    assert.equal((await begin(app, credential)).status, 400);
    const res = await finish(app, authenticator, credential, { challenge: 'x' });
    assert.equal(res.status, 400);
  }
  // Neither attempt may have spent the token.
  assert.equal((await registerWith(app, { setupToken: token })).finished.status, 200);
});

test('the setup password still registers a passkey with tokens outstanding', async () => {
  const { app, token } = await appWithToken();
  const { finished } = await registerWith(app, { password: PASSWORD });
  assert.equal(finished.status, 200);
  // The password path is not the token path: the QR is untouched by it.
  const second = await registerWith(app, { setupToken: token });
  assert.equal(second.finished.status, 200);
});

test('a redemption is announced to the Host that minted the token, and to no other', async () => {
  const created = await freshApp();
  const server = await startServer(created);
  try {
    const minter = await connectHost(created.app, server, { label: 'Laptop A' });
    const other = await connectHost(created.app, server, { label: 'Laptop B' });

    const { token } = await (await mint(created.app, minter.host.hostToken)).json();
    const { finished } = await registerWith(created.app, { setupToken: token });
    assert.equal(finished.status, 200);

    assert.deepEqual(await minter.socket.take(), { t: 'setup-token-redeemed' });
    assert.ok(await other.socket.quiet(), 'only the minting Host hears about its own token');
  } finally {
    await server.close();
  }
});

test('a redemption with no live Host socket still sets the phone up', async () => {
  const { app, token } = await appWithToken();
  const { finished } = await registerWith(app, { setupToken: token });
  assert.equal(finished.status, 200);
});

// --- SetupTokenIssuer directly: expiry, single use, and the cap -------------

test('the issuer answers the minting host, once, and only while fresh', () => {
  const clock = makeClock();
  const issuer = new SetupTokenIssuer({ now: clock.now });

  const { token } = issuer.issue('host-1');
  assert.deepEqual(issuer.peek(token), { hostId: 'host-1' });
  assert.deepEqual(issuer.peek(token), { hostId: 'host-1' }); // peek does not spend
  assert.deepEqual(issuer.consume(token), { hostId: 'host-1' });
  assert.equal(issuer.consume(token), null);
  assert.equal(issuer.peek('never-minted'), null);

  const later = issuer.issue('host-2');
  clock.advance(SETUP_TOKEN_TTL_MS);
  assert.equal(issuer.peek(later.token), null);
  assert.equal(issuer.consume(later.token), null);
});

test('outstanding tokens are pruned and capped, oldest first', () => {
  const clock = makeClock();
  const issuer = new SetupTokenIssuer({ now: clock.now });

  const expiring = issuer.issue('host-1');
  clock.advance(SETUP_TOKEN_TTL_MS);
  // Minting reclaims it: nothing else ever removes an abandoned token.
  issuer.issue('host-1');
  assert.equal(issuer.pendingCount, 1);
  assert.equal(issuer.peek(expiring.token), null);

  // A Host re-rendering its QR in a loop cannot grow the map without bound.
  const minted = [];
  for (let i = 0; i < 200; i++) minted.push(issuer.issue('host-1').token);
  assert.equal(issuer.pendingCount <= 64, true);
  assert.equal(issuer.peek(minted[0]), null);
  assert.notEqual(issuer.peek(minted.at(-1)), null);
});
