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
  REMOTE_EVENTS,
  REMOTE_METHODS,
  SELFHOST_ACCOUNT_ID,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  fromBase64Url,
  generateDeviceKeyPair,
  hashPasskeyPublicKey,
  signDeviceChallenge,
  toBase64Url,
  utf8Decode,
  utf8Encode,
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

// --- Synthetic directory + echo terminal over the real wire -----------------

/** Pair + connect an established phone session, ready for `msg` traffic. */
async function establish(p, hostId) {
  assert.equal((await pair(p, hostId)).approved, true);
  const challengeFrame = await connect(p, hostId);
  assert.equal((await connect2(p, hostId, challengeFrame.challenge)).decision.allowed, true);
}

/** Send a remote-api request over a `msg` frame. */
function remote(p, requestId, method, params) {
  p.socket.send({ t: 'msg', data: { requestId, method, params } });
}

/** Decode a `terminal.data` event frame's base64url utf8 PTY bytes to a string. */
function eventText(frame) {
  return utf8Decode(fromBase64Url(frame.data.data.bytes));
}

test('remote terminal: directory snapshot, attach banner, echo write, resize, detach silences', async () => {
  const { app, server, host, close } = await boot();
  try {
    const p = await phone(app, server);
    await establish(p, host.hostId);

    // directory.watch → ack (subId === requestId) then a snapshot event.
    remote(p, 'dw', REMOTE_METHODS.directoryWatch, {});
    const watchAck = await p.socket.take();
    assert.equal(watchAck.data.requestId, 'dw');
    assert.equal(watchAck.data.ok, true);
    assert.equal(watchAck.data.result.subId, 'dw');

    const snapshot = await p.socket.take();
    assert.equal(snapshot.data.subId, 'dw');
    assert.equal(snapshot.data.event, REMOTE_EVENTS.directorySnapshot);
    const entries = snapshot.data.data.entries;
    assert.equal(entries.length, 2);
    assert.equal(entries[0].type, 'terminal');
    const surfaceId = entries[0].surfaceId;

    // surface.attach → authoritative size + a banner terminal.data event.
    remote(p, 'at', REMOTE_METHODS.surfaceAttach, { surfaceId, cols: 100, rows: 40 });
    const attachAck = await p.socket.take();
    assert.equal(attachAck.data.requestId, 'at');
    assert.equal(attachAck.data.ok, true);
    assert.deepEqual(attachAck.data.result, { cols: 100, rows: 40 });

    const banner = await p.socket.take();
    assert.equal(banner.data.subId, 'at');
    assert.equal(banner.data.event, REMOTE_EVENTS.terminalData);
    const bannerText = eventText(banner);
    assert.match(bannerText, /attached/);
    assert.match(bannerText, /100x40/);

    // terminal.write → ack + the bytes echoed back (with a redrawn prompt).
    remote(p, 'wr', REMOTE_METHODS.terminalWrite, {
      surfaceId,
      bytes: toBase64Url(utf8Encode('echo hi\r')),
    });
    assert.equal((await p.socket.take()).data.ok, true);
    const echo = await p.socket.take();
    assert.equal(echo.data.event, REMOTE_EVENTS.terminalData);
    const echoText = eventText(echo);
    assert.match(echoText, /echo hi/);
    assert.ok(echoText.endsWith('$ '), 'the \\r redraws a fake prompt');

    // terminal.resize → ack + a size-note terminal.data event.
    remote(p, 'rs', REMOTE_METHODS.terminalResize, { surfaceId, cols: 120, rows: 50 });
    const resizeAck = await p.socket.take();
    assert.equal(resizeAck.data.ok, true);
    assert.deepEqual(resizeAck.data.result, { cols: 120, rows: 50 });
    assert.match(eventText(await p.socket.take()), /resized to 120x50/);

    // surface.detach → ack, then a write is acked but produces no more data.
    remote(p, 'dt', REMOTE_METHODS.surfaceDetach, { surfaceId });
    assert.equal((await p.socket.take()).data.ok, true);

    remote(p, 'wr2', REMOTE_METHODS.terminalWrite, {
      surfaceId,
      bytes: toBase64Url(utf8Encode('ping\r')),
    });
    const writeAck2 = await p.socket.take();
    assert.equal(writeAck2.data.requestId, 'wr2');
    assert.equal(writeAck2.data.ok, true);
    assert.ok(await p.socket.quiet(), 'detach silences the stream: no terminal.data after detach');
  } finally {
    await close();
  }
});

// A short settle so no test leaves an in-flight frame racing teardown.
test.after?.(async () => {
  await sleep(10);
});
