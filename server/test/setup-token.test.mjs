/**
 * QR-first phone setup, server half (docs/specs/server.md, "HTTP API" and
 * "Setup tokens"): an enrolled Host mints a single-use setup token, a scanning
 * phone redeems it in place of the setup password, and a phone that already
 * holds a session retires it instead.
 *
 * Redemption announces nothing: the invitation the same QR carries is Host
 * memory, and its state — not the token's — is what the QR panel renders
 * (docs/specs/remote-security-model.md -> Pairing).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { API_ROUTES, SETUP_TOKEN_INVALID_ERROR, UNAUTHORIZED_ERROR } from 'server-lib-common';

import { AccountStore } from '../dist/state.js';
import {
  MAX_TOKENS_PER_HOST,
  SetupTokenIssuer,
  SETUP_TOKEN_TTL_MS,
} from '../dist/setup-token.js';
import { FakeHost } from './harness/fake-host.mjs';
import {
  ORIGIN,
  PASSWORD,
  RP_ID,
  connectHost,
  enrollHost,
  freshApp,
  makeClock,
  newAuthenticator,
  ownerSession,
  post,
  readAccount,
  register,
  registrationClientData,
  sleep,
  startServer,
  until,
} from './helpers.mjs';

/** The 401 body every rejected setup token answers with. */
const REFUSED = { error: SETUP_TOKEN_INVALID_ERROR };

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

/** begin → finish a whole registration off `token`; the finish Response. */
async function registerWithToken(app, token) {
  return register(app, await newAuthenticator(), { credential: { setupToken: token } });
}

/** A FakeHost socket keeps the event loop alive, so teardown must close them. */
const OPEN_FAKE_HOSTS = [];

async function shutdown(server) {
  for (const fake of OPEN_FAKE_HOSTS.splice(0)) fake.close();
  await server.close();
}

/**
 * Enroll a Host and connect it as a {@link FakeHost}, recording every frame the
 * relay delivered to it. The harness mirrors the real Host's frame handling, so
 * a frame it would drop cannot pass for one it received.
 */
async function connectFakeHost(app, server, options) {
  const { body: host } = await enrollHost(app, options);
  const fake = new FakeHost({
    serverUrl: server.wsUrl,
    hostToken: host.hostToken,
    hostId: host.hostId,
    origin: ORIGIN,
    rpId: RP_ID,
  });
  OPEN_FAKE_HOSTS.push(fake);
  await fake.ready;
  return { host, fake };
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
  const authenticator = await newAuthenticator();

  const finished = await register(app, authenticator, {
    credential: { setupToken: token },
    label: 'iPhone Safari',
  });
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
  assert.equal((await registerWithToken(app, token)).status, 200);

  // Everything the spent token can still be presented to answers the same way.
  const again = await begin(app, { setupToken: token });
  assert.equal(again.status, 401);
  assert.deepEqual(await again.json(), REFUSED);
  const authenticator = await newAuthenticator();
  const replay = await finish(app, authenticator, { setupToken: token }, { challenge: 'x' });
  assert.equal(replay.status, 401);
  assert.deepEqual(await replay.json(), REFUSED);
});

test('begin does not spend the token: an abandoned scan can be retried', async () => {
  const { app, token } = await appWithToken();
  // The user scans, backs out, scans again — the QR on the laptop is still good.
  assert.equal((await begin(app, { setupToken: token })).status, 200);
  assert.equal((await registerWithToken(app, token)).status, 200);
});

test('a failed finish restores the token, unspent', async () => {
  const { app, token } = await appWithToken();
  const first = await newAuthenticator();
  const began = await begin(app, { setupToken: token });
  const { challenge } = await began.json();

  // `finish` consumes up front, so a rejection past that point has to put the
  // token back: an ordinary bad attempt must not cost the user the QR.
  const rejected = await post(app, API_ROUTES.setupFinish, {
    setupToken: token,
    credentialId: first.credentialId,
    publicKey: first.publicKey,
    clientDataJSON: registrationClientData({ challenge, origin: 'http://evil.example' }),
    label: 'x',
  });
  assert.equal(rejected.status, 400);

  assert.equal((await registerWithToken(app, token)).status, 200);
});

test('an expired token is refused at begin and at finish', async () => {
  const clock = makeClock();
  const { app, token } = await appWithToken({ now: clock.now });

  clock.advance(SETUP_TOKEN_TTL_MS + 1);

  const late = await begin(app, { setupToken: token });
  assert.equal(late.status, 401);
  assert.deepEqual(await late.json(), REFUSED);

  // The credential gate runs before the challenge is even looked at, so a
  // finish is refused the same way whatever challenge it carries.
  const authenticator = await newAuthenticator();
  const lateFinish = await finish(app, authenticator, { setupToken: token }, { challenge: 'x' });
  assert.equal(lateFinish.status, 401);
  assert.deepEqual(await lateFinish.json(), REFUSED);
});

test('a wrong token answers the one 401, distinct from the session gate', async () => {
  const { app } = await appWithToken();
  const res = await begin(app, { setupToken: 'not-a-minted-token' });
  assert.equal(res.status, 401);
  // Pocket sends setup tokens itself and keys recovery on the body, so a dead
  // one must read as "re-scan", never as the "sign in again" sentinel.
  assert.deepEqual(await res.json(), REFUSED);
  assert.notEqual(SETUP_TOKEN_INVALID_ERROR, UNAUTHORIZED_ERROR);
  // A mistyped credential belongs to that branch, not to the 400 for shape.
  assert.equal((await begin(app, { setupToken: 42 })).status, 401);
});

test('revoking the minting Host kills its outstanding tokens at both gates', async () => {
  const { app, stateDir, token } = await appWithToken();

  // Revocation is editing `hosts.json` by hand (server.md, Guardrails). A
  // token minted before that edit must not stay redeemable for its whole TTL.
  await writeFile(join(stateDir, 'hosts.json'), '[]\n');

  const began = await begin(app, { setupToken: token });
  assert.equal(began.status, 401);
  assert.deepEqual(await began.json(), REFUSED);

  const authenticator = await newAuthenticator();
  const finished = await finish(app, authenticator, { setupToken: token }, { challenge: 'x' });
  assert.equal(finished.status, 401);
  assert.deepEqual(await finished.json(), REFUSED);
});

test('the token is the only credential: a password or nothing is the same 401', async () => {
  const { app, token } = await appWithToken();
  const authenticator = await newAuthenticator();

  for (const credential of [{ password: PASSWORD }, {}]) {
    const began = await begin(app, credential);
    assert.equal(began.status, 401);
    assert.deepEqual(await began.json(), REFUSED);
    const res = await finish(app, authenticator, credential, { challenge: 'x' });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), REFUSED);
  }
  // Neither attempt may have spent the token.
  assert.equal((await registerWithToken(app, token)).status, 200);
});

test('a redemption tells the minting Host nothing: the invitation is its own state', async () => {
  const created = await freshApp();
  const server = await startServer(created);
  try {
    const minter = await connectFakeHost(created.app, server, { label: 'Laptop A' });
    const { token } = await (await mint(created.app, minter.host.hostToken)).json();
    assert.equal((await registerWithToken(created.app, token)).status, 200);

    // The QR panel renders the invitation the Host holds in memory, whose state
    // the pairing ceremony moves. A redemption frame would be a second opinion
    // about the same code, over a wire that carries no credentials.
    await sleep(60);
    assert.deepEqual(minter.fake.frames, [], 'the Host is told nothing about the redemption');
  } finally {
    await shutdown(server);
  }
});

test('two finishes race one token: one registers, the other is refused', async () => {
  const { app, stateDir, token } = await appWithToken();
  const appendPasskey = AccountStore.prototype.appendPasskey;
  try {
    // Two scans of the same QR: `begin` does not spend, so both challenges live.
    const challenges = [];
    for (let i = 0; i < 2; i++) {
      challenges.push((await (await begin(app, { setupToken: token })).json()).challenge);
    }

    // Suspend the first finish inside the account write, so the second runs
    // start to finish while the first holds the token spent but unregistered —
    // the overlap a peek-then-consume gate would let both through.
    let reached;
    let release;
    const arrived = new Promise((resolve) => (reached = resolve));
    const suspended = new Promise((resolve) => (release = resolve));
    let firstCall = true;
    AccountStore.prototype.appendPasskey = async function hooked(...args) {
      if (firstCall) {
        firstCall = false;
        reached();
        await suspended;
      }
      return appendPasskey.apply(this, args);
    };

    const credential = { setupToken: token };
    const first = finish(app, await newAuthenticator(), credential, {
      challenge: challenges[0],
    });
    await arrived;
    const second = await finish(app, await newAuthenticator(), credential, {
      challenge: challenges[1],
    });
    release();
    const firstRes = await first;

    assert.equal(firstRes.status, 200);
    assert.equal(second.status, 401);
    assert.deepEqual(await second.json(), REFUSED);

    const account = await readAccount(stateDir);
    assert.equal(account.passkeys.length, 1, 'exactly one passkey off one token');
  } finally {
    AccountStore.prototype.appendPasskey = appendPasskey;
  }
});

test('a scan whose Host went offline mid-ceremony still sets the phone up', async () => {
  const created = await freshApp();
  const server = await startServer(created);
  try {
    const minter = await connectHost(created.app, server, { label: 'Laptop A' });
    const { token } = await (await mint(created.app, minter.host.hostToken)).json();

    // The laptop lid closes between the scan and the passkey prompt. Setting the
    // account up is a Server-only transaction, so it must not depend on the Host.
    minter.socket.close();
    await until(() => !created.hub.isHostOnline(minter.host.hostId));

    assert.equal((await registerWithToken(created.app, token)).status, 200);
  } finally {
    await shutdown(server);
  }
});

// --- POST /api/setup/retire: spending a scanned code without registering ----

/** `POST /api/setup/retire` under a session bearer. */
function retire(app, sessionToken, body) {
  return app.request(API_ROUTES.setupRetire, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(sessionToken === undefined ? {} : { Authorization: `Bearer ${sessionToken}` }),
    },
    body: JSON.stringify(body ?? {}),
  });
}

test('a signed-in phone retires a live token, and it registers nothing afterwards', async () => {
  // A phone that scans a QR it will not register with spends the code itself,
  // so a photographed one cannot register a passkey later.
  const { app, token } = await appWithToken();
  const { sessionToken } = await ownerSession(app);

  const res = await retire(app, sessionToken, { setupToken: token });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), '', '204 carries no body');

  const began = await begin(app, { setupToken: token });
  assert.equal(began.status, 401);
  assert.deepEqual(await began.json(), REFUSED);
  assert.equal((await registerWithToken(app, token)).status, 401);
});

test('retiring is single-use, and an unknown token answers the one 401', async () => {
  const { app, token } = await appWithToken();
  const { sessionToken } = await ownerSession(app);
  assert.equal((await retire(app, sessionToken, { setupToken: token })).status, 204);

  for (const body of [{ setupToken: token }, { setupToken: 'never-minted' }, { setupToken: 42 }, {}]) {
    const res = await retire(app, sessionToken, body);
    assert.equal(res.status, 401, JSON.stringify(body));
    // Pocket keys "scan again, or type the password" on this body; a spent code
    // must never read as the "sign in again" sentinel.
    assert.deepEqual(await res.json(), REFUSED);
  }
});

test('retiring requires a session, and a revoked minter kills the token there too', async () => {
  const { app, stateDir, token } = await appWithToken();
  const anonymous = await retire(app, undefined, { setupToken: token });
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: UNAUTHORIZED_ERROR });

  // Revocation is editing `hosts.json` by hand (server.md, Guardrails): the
  // same re-read that guards `begin`/`finish` guards this route.
  const { sessionToken } = await ownerSession(app);
  await writeFile(join(stateDir, 'hosts.json'), '[]\n');
  const revoked = await retire(app, sessionToken, { setupToken: token });
  assert.equal(revoked.status, 401);
  assert.deepEqual(await revoked.json(), REFUSED);
});

// --- SetupTokenIssuer directly: expiry, single use, and the cap -------------

test('the issuer answers the minting host, once, and only while fresh', () => {
  const clock = makeClock();
  const issuer = new SetupTokenIssuer({ now: clock.now });

  const { token, expiresAt } = issuer.issue('host-1');
  const entry = { hostId: 'host-1', expiresAt };
  assert.deepEqual(issuer.peek(token), entry);
  assert.deepEqual(issuer.peek(token), entry); // peek does not spend
  assert.deepEqual(issuer.consume(token), entry);
  assert.equal(issuer.consume(token), null);
  assert.equal(issuer.peek('never-minted'), null);

  const later = issuer.issue('host-2');
  clock.advance(SETUP_TOKEN_TTL_MS);
  assert.equal(issuer.peek(later.token), null);
  assert.equal(issuer.consume(later.token), null);
});

test('restore puts a consumed token back on its original expiry', () => {
  const clock = makeClock();
  const issuer = new SetupTokenIssuer({ now: clock.now });

  const { token, expiresAt } = issuer.issue('host-1');
  const entry = issuer.consume(token);
  clock.advance(SETUP_TOKEN_TTL_MS / 2);
  issuer.restore(token, entry);
  // Redeemable again, but not for a moment longer than it started with: a
  // failed attempt must not be a way to extend the shoulder-surf window.
  assert.deepEqual(issuer.peek(token), { hostId: 'host-1', expiresAt });
  clock.advance(SETUP_TOKEN_TTL_MS / 2);
  assert.equal(issuer.peek(token), null);

  // A token that died while the route was failing stays dead.
  const late = issuer.issue('host-1');
  const lateEntry = issuer.consume(late.token);
  clock.advance(SETUP_TOKEN_TTL_MS);
  issuer.restore(late.token, lateEntry);
  assert.equal(issuer.peek(late.token), null);
});

test('restore stays within the Host cap after a concurrent mint fills the slot', () => {
  const clock = makeClock();
  const issuer = new SetupTokenIssuer({ now: clock.now });
  const issued = Array.from({ length: MAX_TOKENS_PER_HOST }, () => issuer.issue('host-1'));

  const spent = issuer.consume(issued[0].token);
  const replacement = issuer.issue('host-1');
  assert.equal(issuer.pendingCount, MAX_TOKENS_PER_HOST);

  // Validation failed after the mint used the apparent vacancy. The failed
  // finish gets its token back, but cannot grow this Host to nine entries.
  issuer.restore(issued[0].token, spent);
  assert.equal(issuer.pendingCount, MAX_TOKENS_PER_HOST);
  assert.deepEqual(issuer.peek(issued[0].token), spent);
  assert.equal(issuer.peek(issued[1].token), null);
  assert.notEqual(issuer.peek(replacement.token), null);
});

test('outstanding tokens are pruned, and capped per minting Host', () => {
  const clock = makeClock();
  const issuer = new SetupTokenIssuer({ now: clock.now });

  const expiring = issuer.issue('host-1');
  clock.advance(SETUP_TOKEN_TTL_MS);
  // Minting reclaims it: nothing else ever removes an abandoned token.
  issuer.issue('host-1');
  assert.equal(issuer.pendingCount, 1);
  assert.equal(issuer.peek(expiring.token), null);

  // A Host re-rendering its QR in a loop cannot grow the map without bound —
  // and evicts only its own oldest, never the token another Host is displaying.
  const displayed = issuer.issue('host-2').token;
  const minted = [];
  for (let i = 0; i < 200; i++) minted.push(issuer.issue('host-1').token);
  assert.equal(issuer.peek(minted[0]), null);
  assert.notEqual(issuer.peek(minted.at(-1)), null);
  assert.notEqual(issuer.peek(displayed), null, "host-2's live token survives host-1's loop");
  // host-1 at its cap, plus host-2's one: the map is bounded by hosts × cap.
  assert.equal(issuer.pendingCount, MAX_TOKENS_PER_HOST + 1);
});
