/**
 * Slice-1 setup/registration coverage (docs/specs/server.md, "Accounts &
 * passkeys"): the password gate, the clientDataJSON sanity checks, single-use
 * challenges, and the account.json that lands on disk.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { API_ROUTES } from 'server-lib-common';

import {
  ORIGIN,
  PASSWORD,
  RP_ID,
  freshApp,
  enrollHost,
  newAuthenticator,
  padBase64Url,
  post,
  readAccount,
  register,
  registrationClientData,
} from './helpers.mjs';

test('register happy path writes account.json', async () => {
  const { app, stateDir } = await freshApp();
  const authenticator = await newAuthenticator();

  const res = await register(app, authenticator, { label: 'iPhone Safari' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    accountId: 'owner',
    credentialId: authenticator.credentialId,
  });

  const account = await readAccount(stateDir);
  assert.equal(account.accountId, 'owner');
  assert.equal(account.passkeys.length, 1);
  const [passkey] = account.passkeys;
  assert.equal(passkey.credentialId, authenticator.credentialId);
  assert.equal(passkey.publicKey, authenticator.publicKey);
  assert.equal(passkey.label, 'iPhone Safari');
  assert.equal(typeof passkey.createdAt, 'number');
});

test('a second passkey can be added by re-presenting the password', async () => {
  const { app, stateDir } = await freshApp();
  assert.equal((await register(app, await newAuthenticator())).status, 200);
  assert.equal((await register(app, await newAuthenticator())).status, 200);
  const account = await readAccount(stateDir);
  assert.equal(account.passkeys.length, 2);
});

test('setup/begin rejects a wrong password', async () => {
  const { app } = await freshApp();
  const res = await post(app, API_ROUTES.setupBegin, { password: 'wrong' });
  assert.equal(res.status, 401);
});

test('setup/finish rejects a wrong password', async () => {
  const { app } = await freshApp();
  const authenticator = await newAuthenticator();
  // Get a valid challenge with the correct password, then finish with a wrong one.
  const begin = await post(app, API_ROUTES.setupBegin, { password: PASSWORD });
  const { challenge } = await begin.json();
  const res = await post(app, API_ROUTES.setupFinish, {
    password: 'wrong',
    credentialId: authenticator.credentialId,
    publicKey: authenticator.publicKey,
    clientDataJSON: registrationClientData({ challenge }),
    label: 'x',
  });
  assert.equal(res.status, 401);
});

test('setup/finish rejects a replayed challenge', async () => {
  const { app } = await freshApp();
  const first = await newAuthenticator();

  const begin = await post(app, API_ROUTES.setupBegin, { password: PASSWORD });
  const { challenge } = await begin.json();
  const clientDataJSON = registrationClientData({ challenge });

  const ok = await post(app, API_ROUTES.setupFinish, {
    password: PASSWORD,
    credentialId: first.credentialId,
    publicKey: first.publicKey,
    clientDataJSON,
    label: 'first',
  });
  assert.equal(ok.status, 200);

  // Reuse the (now consumed) challenge with a different credential.
  const second = await newAuthenticator();
  const replay = await post(app, API_ROUTES.setupFinish, {
    password: PASSWORD,
    credentialId: second.credentialId,
    publicKey: second.publicKey,
    clientDataJSON,
    label: 'second',
  });
  assert.equal(replay.status, 400);
  assert.match((await replay.json()).error, /challenge/);
});

test('setup/finish accepts a padded base64url clientData challenge', async () => {
  const { app } = await freshApp();
  const authenticator = await newAuthenticator();
  const begin = await post(app, API_ROUTES.setupBegin, { password: PASSWORD });
  const { challenge } = await begin.json();

  const res = await post(app, API_ROUTES.setupFinish, {
    password: PASSWORD,
    credentialId: authenticator.credentialId,
    publicKey: authenticator.publicKey,
    clientDataJSON: registrationClientData({ challenge: padBase64Url(challenge) }),
    label: 'x',
  });
  assert.equal(res.status, 200);
});

test('setup/finish rejects a mismatched origin in clientDataJSON', async () => {
  const { app } = await freshApp();
  const authenticator = await newAuthenticator();
  const begin = await post(app, API_ROUTES.setupBegin, { password: PASSWORD });
  const { challenge } = await begin.json();

  const res = await post(app, API_ROUTES.setupFinish, {
    password: PASSWORD,
    credentialId: authenticator.credentialId,
    publicKey: authenticator.publicKey,
    clientDataJSON: registrationClientData({ challenge, origin: 'http://evil.example' }),
    label: 'x',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /origin/);
});

test('setup/finish rejects the wrong clientData type', async () => {
  const { app } = await freshApp();
  const authenticator = await newAuthenticator();
  const begin = await post(app, API_ROUTES.setupBegin, { password: PASSWORD });
  const { challenge } = await begin.json();

  const res = await post(app, API_ROUTES.setupFinish, {
    password: PASSWORD,
    credentialId: authenticator.credentialId,
    publicKey: authenticator.publicKey,
    clientDataJSON: registrationClientData({ challenge, type: 'webauthn.get' }),
    label: 'x',
  });
  assert.equal(res.status, 400);
});

test('setup/finish rejects a duplicate credentialId', async () => {
  const { app } = await freshApp();
  const authenticator = await newAuthenticator();
  assert.equal((await register(app, authenticator)).status, 200);

  const res = await register(app, authenticator);
  assert.equal(res.status, 409);
});

test('setup/finish rejects an unimportable public key', async () => {
  const { app } = await freshApp();
  const authenticator = await newAuthenticator();
  const begin = await post(app, API_ROUTES.setupBegin, { password: PASSWORD });
  const { challenge } = await begin.json();

  const res = await post(app, API_ROUTES.setupFinish, {
    password: PASSWORD,
    credentialId: authenticator.credentialId,
    publicKey: 'bm90LWEta2V5', // "not-a-key", valid base64url but not SPKI
    clientDataJSON: registrationClientData({ challenge }),
    label: 'x',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /public key/);
});

test('origin/rpId derive from config', async () => {
  const { app } = await freshApp();
  const begin = await post(app, API_ROUTES.setupBegin, { password: PASSWORD });
  const body = await begin.json();
  assert.equal(body.rpId, RP_ID);
  assert.equal(body.accountId, 'owner');
  assert.equal(typeof body.challenge, 'string');
  assert.equal(new URL(ORIGIN).hostname, RP_ID);
});

test('configured origin is normalized for setup and Host policy', async () => {
  const { app } = await freshApp({ origin: 'https://Example.COM/' });
  const authenticator = await newAuthenticator();
  const begin = await post(app, API_ROUTES.setupBegin, { password: PASSWORD });
  const { challenge, rpId } = await begin.json();
  assert.equal(rpId, 'example.com');

  const finish = await post(app, API_ROUTES.setupFinish, {
    password: PASSWORD,
    credentialId: authenticator.credentialId,
    publicKey: authenticator.publicKey,
    clientDataJSON: registrationClientData({ challenge, origin: 'https://example.com' }),
    label: 'x',
  });
  assert.equal(finish.status, 200);

  const { res, body } = await enrollHost(app);
  assert.equal(res.status, 200);
  assert.equal(body.origin, 'https://example.com');
  assert.equal(body.rpId, 'example.com');
});
