/**
 * Slice-3 security handshake, end to end through a real listening server
 * (docs/specs/server.md "Relay"; docs/specs/remote-security-model.md). The
 * "phone" is a real WebAuthn authenticator (`SimAuthenticator`) plus a real
 * device keypair (`generateDeviceKeyPair` / `signDeviceChallenge`); the "laptop"
 * is the reusable `FakeHost` wiring the actual security primitives. Nothing is
 * stubbed but the transport is loopback.
 *
 * The deny cases prove the two independent guarantees of the model: the server
 * refuses to relay anything it cannot verify (a forged request never even burns
 * a Host challenge), and the Host is the final authority for everything the
 * server cannot see (a registered passkey on an unpaired device is denied by
 * the Host after the server forwards it).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SELFHOST_ACCOUNT_ID,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  generateDeviceKeyPair,
  hashPasskeyPublicKey,
  signDeviceChallenge,
  toBase64Url,
} from 'server-lib-common';

import {
  ORIGIN,
  RP_ID,
  enrollHost,
  freshApp,
  newAuthenticator,
  ownerSession,
  sleep,
  startServer,
  wsConnect,
} from './helpers.mjs';
import { FakeHost } from './harness/fake-host.mjs';

// --- Fixtures --------------------------------------------------------------

/** Boot a server + one enrolled `FakeHost`, ready to accept clients. */
async function boot({ autoApprove = true } = {}) {
  const created = await freshApp();
  const server = await startServer(created);
  const { body: host } = await enrollHost(created.app, { label: 'Laptop' });
  const fakeHost = await startFakeHost(server, host, { autoApprove });
  const extraHosts = [];
  const close = async () => {
    fakeHost.close();
    for (const h of extraHosts) h.close();
    await server.close();
  };
  return { app: created.app, server, host, fakeHost, extraHosts, close };
}

/** Connect a `FakeHost` for an already-enrolled host record. */
async function startFakeHost(server, host, { autoApprove = true } = {}) {
  const fakeHost = new FakeHost({
    serverUrl: server.wsUrl,
    hostToken: host.hostToken,
    hostId: host.hostId,
    origin: host.origin,
    rpId: host.rpId,
    autoApprove,
  });
  await fakeHost.ready;
  return fakeHost;
}

/**
 * A "phone": a registered passkey (the authenticator), a device keypair, and a
 * live client socket authenticated with the session token from the same sign-in.
 */
async function phone(app, server) {
  const { authenticator, sessionToken } = await ownerSession(app);
  const socket = wsConnect(`${server.wsUrl}${WS_ROUTES.client}?${WS_TOKEN_PARAM}=${sessionToken}`);
  await socket.ready;
  const deviceKey = await generateDeviceKeyPair();
  return { authenticator, sessionToken, socket, deviceKey };
}

/** Collect the named FakeHost events into one array, in arrival order. */
function collect(fakeHost, ...names) {
  const events = [];
  for (const name of names) fakeHost.on(name, (payload) => events.push({ name, ...payload }));
  return events;
}

// --- Request builders (with tamper knobs for the deny cases) ---------------

async function buildPairingRequest(p, overrides = {}) {
  return {
    accountId: SELFHOST_ACCOUNT_ID,
    passkeyCredentialId: p.authenticator.credentialId,
    passkeyPublicKeyHash: await hashPasskeyPublicKey(p.authenticator.publicKey),
    devicePublicKey: p.deviceKey.devicePublicKey,
    requestedLabel: 'iPhone Safari',
    ...overrides,
  };
}

async function buildConnectionRequest(p, challenge, hostId, tamper = {}) {
  const authenticator = tamper.assertWith ?? p.authenticator;
  const assertion = await authenticator.assert({
    challenge: tamper.assertChallenge ?? challenge,
    origin: ORIGIN,
    rpId: RP_ID,
    tamper: tamper.assertion ?? {},
  });
  const deviceSignature = await signDeviceChallenge(p.deviceKey.privateKey, {
    hostId: tamper.signForHostId ?? hostId,
    challenge,
    devicePublicKey: p.deviceKey.devicePublicKey,
  });
  return {
    accountId: tamper.accountId ?? SELFHOST_ACCOUNT_ID,
    devicePublicKey: p.deviceKey.devicePublicKey,
    challenge: tamper.requestChallenge ?? challenge,
    deviceSignature,
    passkey: {
      publicKey: tamper.passkeyPublicKey ?? authenticator.publicKey,
      assertion,
    },
  };
}

// --- Flow helpers ----------------------------------------------------------

async function pair(p, hostId, overrides) {
  p.socket.send({ t: 'pair', hostId, request: await buildPairingRequest(p, overrides) });
  return p.socket.take();
}

async function connect(p, hostId) {
  p.socket.send({ t: 'connect', hostId });
  return p.socket.take(); // the relayed `challenge` frame
}

async function connect2(p, hostId, challenge, tamper) {
  const request = await buildConnectionRequest(p, challenge, hostId, tamper);
  p.socket.send({ t: 'connect2', hostId, request });
  return { request, decision: await p.socket.take() };
}

function helloRequest(requestId = 'r1') {
  return { requestId, method: 'hello', params: { protocolVersion: 1, viewer: 'phone' } };
}

/** A fresh, well-formed base64url value that is not equal to a real challenge. */
function otherChallenge() {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

// --- The full flow ---------------------------------------------------------

test('pair (autoApprove) → approved with an ACL record for this phone', async () => {
  const { app, server, host, fakeHost, close } = await boot();
  try {
    const p = await phone(app, server);
    const result = await pair(p, host.hostId);

    assert.equal(result.t, 'pair-result');
    assert.equal(result.approved, true);
    assert.equal(result.clientId, undefined, 'the clientId secret never leaks to the phone');
    assert.equal(result.record.hostId, host.hostId);
    assert.equal(result.record.accountId, SELFHOST_ACCOUNT_ID);
    assert.equal(result.record.passkeyCredentialId, p.authenticator.credentialId);
    assert.equal(result.record.devicePublicKey, p.deviceKey.devicePublicKey);
    assert.equal(result.record.label, 'iPhone Safari');
    // The Host actually wrote it.
    assert.equal(fakeHost.acl.activeRecords().length, 1);
  } finally {
    await close();
  }
});

test('connect → challenge → connect2 allowed → hello round-trips, unknown method refused', async () => {
  const { app, server, host, fakeHost, close } = await boot();
  try {
    const p = await phone(app, server);
    assert.equal((await pair(p, host.hostId)).approved, true);

    const challengeFrame = await connect(p, host.hostId);
    assert.equal(challengeFrame.t, 'challenge');
    assert.equal(challengeFrame.hostId, host.hostId);
    assert.equal(typeof challengeFrame.challenge, 'string');

    const { decision } = await connect2(p, host.hostId, challengeFrame.challenge);
    assert.deepEqual(decision, { t: 'decision', allowed: true });

    // hello over the now-opaque `msg` relay.
    p.socket.send({ t: 'msg', data: helloRequest('r1') });
    const hello = await p.socket.take();
    assert.equal(hello.t, 'msg');
    assert.equal(hello.data.requestId, 'r1');
    assert.equal(hello.data.ok, true);
    assert.equal(hello.data.result.protocolVersion, 1);
    assert.equal(hello.data.result.hostId, host.hostId);

    // Unknown methods echo ok:false.
    p.socket.send({ t: 'msg', data: { requestId: 'r2', method: 'frobnicate' } });
    const echoed = await p.socket.take();
    assert.equal(echoed.data.requestId, 'r2');
    assert.equal(echoed.data.ok, false);
    assert.match(echoed.data.error, /unknown method/);

    assert.equal(fakeHost.established.size, 1);
  } finally {
    await close();
  }
});

// --- Host is the final authority -------------------------------------------

test('unpaired device: server forwards, Host denies (device-not-paired), msg stays blocked', async () => {
  const { app, server, host, fakeHost, close } = await boot();
  try {
    const p = await phone(app, server);
    // Deliberately skip pairing: the passkey is registered to the account, so
    // every server-side check passes and the request is forwarded — but the
    // Host has no ACL record for this device key.
    const decisions = collect(fakeHost, 'decision');
    const challengeFrame = await connect(p, host.hostId);
    const { decision } = await connect2(p, host.hostId, challengeFrame.challenge);

    assert.equal(decision.t, 'decision');
    assert.equal(decision.allowed, false);
    assert.ok(decision.failures.includes('device-not-paired'), JSON.stringify(decision.failures));
    assert.equal(decisions.length, 1, 'the Host actually saw the connect2 (server forwarded it)');

    // A denied decision never establishes the session: msg is dropped both ways.
    const msgs = collect(fakeHost, 'msg');
    p.socket.send({ t: 'msg', data: helloRequest('blocked') });
    assert.ok(await p.socket.quiet(), 'no msg response after a denied decision');
    assert.equal(msgs.length, 0, 'the Host never receives msg for an unestablished client');
  } finally {
    await close();
  }
});

// --- Server refuses to relay what it cannot verify -------------------------

test('server rejects a pair for a credential not on the account, without forwarding', async () => {
  const { app, server, host, fakeHost, close } = await boot();
  try {
    const p = await phone(app, server);
    const pairs = collect(fakeHost, 'pair');
    const stranger = await newAuthenticator(); // never registered

    const result = await pair(p, host.hostId, {
      passkeyCredentialId: stranger.credentialId,
      passkeyPublicKeyHash: await hashPasskeyPublicKey(stranger.publicKey),
    });

    assert.equal(result.t, 'pair-result');
    assert.equal(result.approved, false);
    assert.match(result.error, /not registered/);
    assert.equal(pairs.length, 0, 'the Host never saw the forged pair request');
  } finally {
    await close();
  }
});

test('server rejects connect2 when the assertion is bound to a different challenge', async () => {
  const { app, server, host, fakeHost, close } = await boot();
  try {
    const p = await phone(app, server);
    assert.equal((await pair(p, host.hostId)).approved, true);
    const decisions = collect(fakeHost, 'decision');

    const challengeFrame = await connect(p, host.hostId);
    const { decision } = await connect2(p, host.hostId, challengeFrame.challenge, {
      assertChallenge: otherChallenge(), // assertion signs a stale/other challenge
    });

    assert.equal(decision.allowed, false);
    assert.ok(
      decision.failures.includes('passkey-assertion-invalid'),
      JSON.stringify(decision.failures),
    );
    assert.equal(decisions.length, 0, 'rejected before forwarding — Host challenge stays unburned');
  } finally {
    await close();
  }
});

test('server rejects connect2 for an unknown (unregistered) credential', async () => {
  const { app, server, host, fakeHost, close } = await boot();
  try {
    const p = await phone(app, server);
    assert.equal((await pair(p, host.hostId)).approved, true);
    const decisions = collect(fakeHost, 'decision');

    const stranger = await newAuthenticator(); // valid assertions, but not registered
    const challengeFrame = await connect(p, host.hostId);
    const { decision } = await connect2(p, host.hostId, challengeFrame.challenge, {
      assertWith: stranger,
    });

    assert.equal(decision.allowed, false);
    assert.ok(decision.failures.includes('passkey-not-paired'), JSON.stringify(decision.failures));
    assert.equal(decisions.length, 0, 'rejected before forwarding');
  } finally {
    await close();
  }
});

test('server rejects connect2 when the passkey publicKey is substituted', async () => {
  const { app, server, host, fakeHost, close } = await boot();
  try {
    const p = await phone(app, server);
    assert.equal((await pair(p, host.hostId)).approved, true);
    const decisions = collect(fakeHost, 'decision');

    // A compromised server could swap the presented key; verification against the
    // STORED key must still catch it.
    const substitute = await newAuthenticator();
    const challengeFrame = await connect(p, host.hostId);
    const { decision } = await connect2(p, host.hostId, challengeFrame.challenge, {
      passkeyPublicKey: substitute.publicKey,
    });

    assert.equal(decision.allowed, false);
    assert.ok(decision.failures.includes('passkey-key-mismatch'), JSON.stringify(decision.failures));
    assert.equal(decisions.length, 0, 'rejected before forwarding');
  } finally {
    await close();
  }
});

test('server rejects a replayed connect2 (same challenge twice) before forwarding', async () => {
  const { app, server, host, fakeHost, close } = await boot();
  try {
    const p = await phone(app, server);
    assert.equal((await pair(p, host.hostId)).approved, true);
    const decisions = collect(fakeHost, 'decision');

    const challengeFrame = await connect(p, host.hostId);
    const { request, decision } = await connect2(p, host.hostId, challengeFrame.challenge);
    assert.equal(decision.allowed, true);
    assert.equal(decisions.length, 1);

    // Resend the exact same connect2. The server's relayed challenge is single-use.
    p.socket.send({ t: 'connect2', hostId: host.hostId, request });
    const replay = await p.socket.take();
    assert.equal(replay.allowed, false);
    assert.ok(replay.failures.includes('challenge-invalid'), JSON.stringify(replay.failures));
    assert.equal(decisions.length, 1, 'the Host never saw the replay');
  } finally {
    await close();
  }
});

// --- Stale-session invalidation on Host restart/replacement -----------------

test('a Host restart invalidates an established session (host-gone, then msg blocked)', async () => {
  const { app, server, host, fakeHost, extraHosts, close } = await boot();
  try {
    const p = await phone(app, server);
    assert.equal((await pair(p, host.hostId)).approved, true);
    const challengeFrame = await connect(p, host.hostId);
    assert.equal((await connect2(p, host.hostId, challengeFrame.challenge)).decision.allowed, true);

    // Prove the session works first.
    p.socket.send({ t: 'msg', data: helloRequest('r1') });
    assert.equal((await p.socket.take()).data.ok, true);

    // The Host "restarts": a new socket for the same host displaces the old one.
    // Its ACL is empty again, so the old established session must be invalidated.
    const restarted = await startFakeHost(server, host);
    extraHosts.push(restarted);

    const gone = await p.socket.take();
    assert.deepEqual(gone, { t: 'host-gone' });

    const msgs = collect(restarted, 'msg');
    p.socket.send({ t: 'msg', data: helloRequest('r2') });
    assert.ok(await p.socket.quiet(), 'the old session no longer relays msg');
    assert.equal(msgs.length, 0, 'the restarted Host receives nothing from the stale client');
  } finally {
    await close();
  }
});

// A short settle so no test leaves an in-flight frame racing teardown.
test.after?.(async () => {
  await sleep(10);
});
