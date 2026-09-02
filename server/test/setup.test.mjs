/**
 * Setup/registration coverage (docs/specs/server.md, "HTTP API"): the setup
 * token is the only gate, the clientDataJSON sanity checks, single-use
 * challenges, and the account.json that lands on disk.
 *
 * Every registration here mints its token through a real enrolled Host
 * (`mintSetupToken`), which is the only way a passkey is registered at all —
 * the setup password enrolls Hosts and registers nothing.
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
  mintSetupToken,
  newAuthenticator,
  padBase64Url,
  post,
  readAccount,
  register,
  registrationClientData,
} from './helpers.mjs';

/** A live setup token plus the challenge `begin` answers it with. */
async function beginWithToken(app) {
  const { token } = await mintSetupToken(app);
  const begin = await post(app, API_ROUTES.setupBegin, { setupToken: token });
  const { challenge } = await begin.json();
  return { token, challenge };
}

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

test('a second passkey needs a second setup token', async () => {
  const { app, stateDir } = await freshApp();
  assert.equal((await register(app, await newAuthenticator())).status, 200);
  assert.equal((await register(app, await newAuthenticator())).status, 200);
  const account = await readAccount(stateDir);
  assert.equal(account.passkeys.length, 2);
});

test('setup/begin names the credentials the account already holds', async () => {
  // For the browser's `excludeCredentials`: only the Server knows what is
  // registered, so a retry cannot silently mint a duplicate of a passkey that
  // can already sign in. Nothing new is disclosed — the gate above ran first.
  const { app } = await freshApp();

  const { token: firstToken } = await mintSetupToken(app);
  const empty = await post(app, API_ROUTES.setupBegin, { setupToken: firstToken });
  assert.deepEqual((await empty.json()).existingCredentialIds, []);

  const first = await newAuthenticator();
  assert.equal((await register(app, first)).status, 200);
  const second = await newAuthenticator();
  assert.equal((await register(app, second)).status, 200);

  const { token } = await mintSetupToken(app);
  const listed = await post(app, API_ROUTES.setupBegin, { setupToken: token });
  assert.deepEqual((await listed.json()).existingCredentialIds, [
    first.credentialId,
    second.credentialId,
  ]);
});

test('the setup password no longer registers anything', async () => {
  // The whole of what 4c deleted: a caller holding the password can enroll a
  // Host, and reaches `/api/setup/*` no further than an unauthenticated one.
  const { app } = await freshApp();
  for (const body of [{ password: PASSWORD }, {}]) {
    const res = await post(app, API_ROUTES.setupBegin, body);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'invalid setup token');
  }
});

test('setup/begin rejects an unknown setup token', async () => {
  const { app } = await freshApp();
  const res = await post(app, API_ROUTES.setupBegin, { setupToken: 'nope' });
  assert.equal(res.status, 401);
});

test('setup/finish rejects an unknown setup token', async () => {
  const { app } = await freshApp();
  const authenticator = await newAuthenticator();
  // Get a valid challenge with a real token, then finish with a bogus one.
  const { challenge } = await beginWithToken(app);
  const res = await post(app, API_ROUTES.setupFinish, {
    setupToken: 'nope',
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

  const { token, challenge } = await beginWithToken(app);
  const clientDataJSON = registrationClientData({ challenge });

  const ok = await post(app, API_ROUTES.setupFinish, {
    setupToken: token,
    credentialId: first.credentialId,
    publicKey: first.publicKey,
    clientDataJSON,
    label: 'first',
  });
  assert.equal(ok.status, 200);

  // Reuse the (now consumed) challenge with a different credential and a fresh
  // token, so it is the challenge and not the credential that refuses it.
  const second = await newAuthenticator();
  const { token: nextToken } = await mintSetupToken(app);
  const replay = await post(app, API_ROUTES.setupFinish, {
    setupToken: nextToken,
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
  const { token, challenge } = await beginWithToken(app);

  const res = await post(app, API_ROUTES.setupFinish, {
    setupToken: token,
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
  const { token, challenge } = await beginWithToken(app);

  const res = await post(app, API_ROUTES.setupFinish, {
    setupToken: token,
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
  const { token, challenge } = await beginWithToken(app);

  const res = await post(app, API_ROUTES.setupFinish, {
    setupToken: token,
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
  const { token, challenge } = await beginWithToken(app);

  const res = await post(app, API_ROUTES.setupFinish, {
    setupToken: token,
    credentialId: authenticator.credentialId,
    publicKey: 'bm90LWEta2V5', // "not-a-key", valid base64url but not SPKI
    clientDataJSON: registrationClientData({ challenge }),
    label: 'x',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /public key/);
});

test('setup/finish rejects a credentialId it could not hand back', async () => {
  // It is stored verbatim and returned to every later `setup/begin` as an
  // `existingCredentialIds` entry, which the Client base64url-decodes — so one
  // malformed id from a holder of one live setup token would wedge passkey
  // registration for the account until `account.json` is hand-edited.
  const { app } = await freshApp();
  const authenticator = await newAuthenticator();
  const { token, challenge } = await beginWithToken(app);

  const res = await post(app, API_ROUTES.setupFinish, {
    setupToken: token,
    credentialId: '!!!not base64url!!!',
    publicKey: authenticator.publicKey,
    clientDataJSON: registrationClientData({ challenge }),
    label: 'x',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /credentialId/);

  // And the account is still registrable — nothing was stored.
  assert.equal((await register(app, authenticator)).status, 200);
});

test('origin/rpId derive from config', async () => {
  const { app } = await freshApp();
  const { token } = await mintSetupToken(app);
  const begin = await post(app, API_ROUTES.setupBegin, { setupToken: token });
  const body = await begin.json();
  assert.equal(body.rpId, RP_ID);
  assert.equal(body.accountId, 'owner');
  assert.equal(typeof body.challenge, 'string');
  assert.equal(new URL(ORIGIN).hostname, RP_ID);
});

// The configured origin — already bare, since `readConfig` normalizes it and
// `config.test.mjs` pins that — reaching all three of setup's rpId, the
// clientData check, and the policy a Host enrolls with.
test('the configured origin drives setup and Host policy', async () => {
  const { app } = await freshApp({ origin: 'https://example.com' });
  const authenticator = await newAuthenticator();
  const { token } = await mintSetupToken(app);
  const begin = await post(app, API_ROUTES.setupBegin, { setupToken: token });
  const { challenge, rpId } = await begin.json();
  assert.equal(rpId, 'example.com');

  const finish = await post(app, API_ROUTES.setupFinish, {
    setupToken: token,
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

test('a passkey label is bounded and reduced before it is persisted', async () => {
  // `account.json` is durable and is re-read and re-parsed on every sign-in and
  // every re-auth, while the two sibling fields on this route are already
  // bounded, so an unbounded label was an omission rather than a policy.
  const { app, stateDir } = await freshApp();
  const authenticator = await newAuthenticator();
  const res = await register(app, authenticator, {
    // Long, and carrying a bidi override plus a control character.
    label: `‮Pixel ${'x'.repeat(4096)}`,
  });
  assert.equal(res.status, 200);

  const account = await readAccount(stateDir);
  const { label } = account.passkeys[0];
  assert.ok([...label].length <= 64, `stored ${[...label].length} code points`);
  assert.equal(label.includes('‮'), false, 'bidi overrides are stripped');
  assert.equal(label.includes(''), false, 'control characters are stripped');
  assert.match(label, /^Pixel/);
});
