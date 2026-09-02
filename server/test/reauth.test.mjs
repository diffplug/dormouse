/**
 * The presence proof both ceremonies carry: `POST /api/reauth/begin` and
 * `/finish` (docs/specs/server.md -> HTTP API;
 * docs/specs/remote-security-model.md -> Presence proofs).
 *
 * The challenge is derived from a kind-tagged binding rather than random, which
 * is what makes an assertion produced for one pairing or connection useless in
 * any other. The Server is not the authority here — the Host recomputes the
 * same challenge and verifies the same assertion — so these cases are about the
 * one thing the Server *is* responsible for: minting a nonce it can be held to,
 * spending it once, and never extending anything in the process.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { API_ROUTES, presenceChallenge, toBase64Url } from 'server-lib-common';

import {
  ORIGIN,
  RP_ID,
  freshApp,
  makeClock,
  newAuthenticator,
  ownerSession,
  register,
} from './helpers.mjs';

/** A well-formed base64url 32-byte value; the routing fields are opaque here. */
function random32() {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/** A pairing binding for `authenticator`, the cheapest well-formed one. */
function pairingBinding(authenticator, overrides = {}) {
  return {
    kind: 'pairing',
    hostId: 'host-1',
    handshakeHash: random32(),
    passkeyCredentialId: authenticator.credentialId,
    ...overrides,
  };
}

function authed(app, path, sessionToken, body) {
  return app.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(sessionToken === undefined ? {} : { Authorization: `Bearer ${sessionToken}` }),
    },
    body: JSON.stringify(body ?? {}),
  });
}

const begin = (app, sessionToken, body) => authed(app, API_ROUTES.reauthBegin, sessionToken, body);
const finish = (app, sessionToken, body) => authed(app, API_ROUTES.reauthFinish, sessionToken, body);

/** begin → assert → the pieces `finish` needs, for `binding`. */
async function proveFor(app, sessionToken, authenticator, binding) {
  const res = await begin(app, sessionToken, { binding });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  const assertion = await authenticator.assert({
    challenge: body.challenge,
    origin: ORIGIN,
    rpId: RP_ID,
  });
  return { ...body, assertion };
}

test('begin answers the challenge derived from the binding, and only that credential', async () => {
  const { app } = await freshApp();
  const { authenticator, sessionToken } = await ownerSession(app);
  const binding = pairingBinding(authenticator);

  const res = await begin(app, sessionToken, { binding });
  assert.equal(res.status, 200);
  const body = await res.json();
  // Independently recomputed: the Host runs exactly this to check the proof, so
  // a Server that derived it differently would deny every ceremony.
  assert.equal(body.challenge, await presenceChallenge(binding, body.serverNonce));
  assert.equal(body.rpId, RP_ID);
  // The one credential the ceremony may assert with. A `get()` that could
  // answer with any of the account's passkeys would let a synced credential the
  // Host never paired satisfy a proof bound to one it did.
  assert.deepEqual(body.allowCredentials, [authenticator.credentialId]);
  assert.match(body.serverNonce, /^[A-Za-z0-9_-]{43}$/, '32 bytes, base64url');
});

test('begin refuses a binding naming a credential this account never registered', async () => {
  const { app } = await freshApp();
  const { authenticator, sessionToken } = await ownerSession(app);
  const stranger = await newAuthenticator();

  const res = await begin(app, sessionToken, { binding: pairingBinding(stranger) });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /unknown credential/);
  // The account's own credential still works, so this is the binding's fault.
  assert.equal((await begin(app, sessionToken, { binding: pairingBinding(authenticator) })).status, 200);
});

test('begin refuses a malformed binding rather than deriving something from it', async () => {
  const { app } = await freshApp();
  const { authenticator, sessionToken } = await ownerSession(app);

  const malformed = [
    // Not a kind at all, and a connection binding missing its Host challenge:
    // the closed shape is what keeps unauthenticated data out of a structure
    // the Host has just verified.
    { kind: 'nonsense', hostId: 'h', handshakeHash: random32(), passkeyCredentialId: 'c' },
    {
      kind: 'connection',
      hostId: 'h',
      connectionId: random32(),
      handshakeHash: random32(),
      passkeyCredentialId: authenticator.credentialId,
    },
    { ...pairingBinding(authenticator), extra: 'field' },
    42,
  ];
  for (const binding of malformed) {
    const res = await begin(app, sessionToken, { binding });
    assert.equal(res.status, 400, JSON.stringify(binding));
  }
  // Bounded, but not base64url where the builder decodes: a throw is a 400, not
  // a 500, and nothing is remembered for it.
  const underivable = await begin(app, sessionToken, {
    binding: pairingBinding(authenticator, { handshakeHash: 'not base64url!' }),
  });
  assert.equal(underivable.status, 400);
});

test('finish verifies the assertion, extends nothing, and spends the nonce', async () => {
  const clock = makeClock();
  const { app, sessions } = await freshApp({ now: clock.now });
  const { authenticator, sessionToken } = await ownerSession(app);
  const before = { ...sessions.validate(sessionToken) };

  clock.advance(1000);
  const proof = await proveFor(app, sessionToken, authenticator, pairingBinding(authenticator));
  const res = await finish(app, sessionToken, {
    serverNonce: proof.serverNonce,
    assertion: proof.assertion,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { verifiedAt: clock.now() });

  // The session is authentication-plane only: this exchange is not reusable
  // proof of presence for a Host, so it moves neither the token's life nor the
  // legacy presence stamp.
  const after = sessions.validate(sessionToken);
  assert.equal(after.expiresAt, before.expiresAt);
  assert.equal(after.lastVerifiedPresence, before.lastVerifiedPresence);

  // Single use: one WebAuthn prompt may not prove presence for two ceremonies.
  const replay = await finish(app, sessionToken, {
    serverNonce: proof.serverNonce,
    assertion: proof.assertion,
  });
  assert.equal(replay.status, 400);
  assert.match((await replay.json()).error, /nonce/);
});

test('finish refuses a nonce past its TTL, and one that was never minted', async () => {
  const clock = makeClock();
  const { app } = await freshApp({ now: clock.now });
  const { authenticator, sessionToken } = await ownerSession(app);
  const proof = await proveFor(app, sessionToken, authenticator, pairingBinding(authenticator));

  // Two minutes, like a Host challenge: both bound one ceremony's prompt.
  clock.advance(2 * 60 * 1000 + 1);
  const late = await finish(app, sessionToken, {
    serverNonce: proof.serverNonce,
    assertion: proof.assertion,
  });
  assert.equal(late.status, 400);

  const unknown = await finish(app, sessionToken, {
    serverNonce: random32(),
    assertion: proof.assertion,
  });
  assert.equal(unknown.status, 400);
});

test('finish refuses an assertion by a credential the binding did not name', async () => {
  const { app } = await freshApp();
  const { authenticator, sessionToken } = await ownerSession(app);
  // A second registered passkey: on the account, so the stored key exists, but
  // not the one this ceremony bound — and the Host will check the ACL against
  // the bound identity, not against "some passkey of this account".
  const other = await newAuthenticator();
  assert.equal((await register(app, other)).status, 200);

  const nonce = await proveFor(app, sessionToken, authenticator, pairingBinding(authenticator));
  const wrong = await other.assert({ challenge: nonce.challenge, origin: ORIGIN, rpId: RP_ID });
  const res = await finish(app, sessionToken, { serverNonce: nonce.serverNonce, assertion: wrong });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /different credential/);
});

test('finish refuses a signature that does not verify against the stored key', async () => {
  const { app } = await freshApp();
  const { authenticator, sessionToken } = await ownerSession(app);
  const proof = await proveFor(app, sessionToken, authenticator, pairingBinding(authenticator));
  // The right credential id over the right challenge, signed by a foreign key.
  const forged = {
    ...proof.assertion,
    signature: (await authenticator.assert({ challenge: random32(), origin: ORIGIN, rpId: RP_ID }))
      .signature,
  };
  const res = await finish(app, sessionToken, {
    serverNonce: proof.serverNonce,
    assertion: forged,
  });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /assertion rejected/);
});

test('both routes require a session', async () => {
  const { app } = await freshApp();
  const authenticator = await newAuthenticator();
  await register(app, authenticator);
  assert.equal((await begin(app, undefined, { binding: pairingBinding(authenticator) })).status, 401);
  assert.equal((await finish(app, undefined, { serverNonce: random32() })).status, 401);
});

test('a request with no binding is refused, not answered with a random challenge', async () => {
  // The one arm 4c deleted. A bodyless `begin` used to mint a sign-in-shaped
  // challenge; it must now fail closed, answering no `serverNonce` a proof
  // could be built around.
  const { app } = await freshApp();
  const { sessionToken } = await ownerSession(app);
  const res = await begin(app, sessionToken, {});
  assert.equal(res.status, 400);
  assert.equal((await res.json()).serverNonce, undefined);

  const finished = await finish(app, sessionToken, {});
  assert.equal(finished.status, 400);
});
