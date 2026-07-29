/**
 * Web Push subscriptions and delivery (docs/specs/alert.md -> Push
 * notifications, docs/specs/server.md -> HTTP API).
 *
 * Two credentials meet here: a Client registers its own subscription with a
 * session token plus a device signature, and a Host reads and sends with its
 * `hostToken`. The cases that matter are the ones where those two must NOT
 * reach each other's data.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { API_ROUTES, signPushSubscribe } from 'server-lib-common';

import { SimClient } from '../../server-lib-common/test/harness/actors.mjs';
import { ORIGIN, enrollHost, fakePushSender, freshApp, ownerSession, post } from './helpers.mjs';

const VAPID_PUBLIC = 'BJxKIjEEuJH0dLHTAcMFVYRnLsIBWcuMt5S1FCdDLbxCkmpUuLfHTFzWSFCPFTFsFvT8sVFTFxKIjEE';

function subscription(endpoint = 'https://push.example.com/sub/abc') {
  return { endpoint, keys: { p256dh: 'BFakeP256dhKey', auth: 'FakeAuthSecret' } };
}

/** A fresh app with push configured, plus an enrolled host and a signed-in owner. */
async function pushApp() {
  const sender = fakePushSender();
  const app = await freshApp({ vapidPublicKey: VAPID_PUBLIC, pushSender: sender });
  const { body: host } = await enrollHost(app.app, { label: 'Laptop' });
  const { sessionToken } = await ownerSession(app.app);
  return { ...app, sender, host, sessionToken };
}

function authed(app, path, token, body) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  });
}

/** Full subscribe round-trip for `client` against `host`; returns the response. */
async function subscribe(app, { sessionToken, host, client, sub = subscription() }) {
  const challengeRes = await authed(app, API_ROUTES.pushChallenge, sessionToken, {
    hostId: host.hostId,
  });
  const { challenge } = await challengeRes.json();
  const signature = await signPushSubscribe(client.deviceKey.privateKey, {
    hostId: host.hostId,
    challenge,
    devicePublicKey: client.deviceKey.devicePublicKey,
    endpoint: sub.endpoint,
  });
  return authed(app, API_ROUTES.pushSubscribe, sessionToken, {
    hostId: host.hostId,
    devicePublicKey: client.deviceKey.devicePublicKey,
    challenge,
    signature,
    subscription: sub,
  });
}

function sendAs(app, hostToken, body) {
  return authed(app, API_ROUTES.pushSend, hostToken, body);
}

// --- config ----------------------------------------------------------------

test('config reports the VAPID public key without auth', async () => {
  const { app } = await freshApp({ vapidPublicKey: VAPID_PUBLIC });
  const res = await app.request(API_ROUTES.pushConfig);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { applicationServerKey: VAPID_PUBLIC });
});

test('config reports null when push is unconfigured, and subscribe is unavailable', async () => {
  const { app } = await freshApp();
  const res = await app.request(API_ROUTES.pushConfig);
  assert.deepEqual(await res.json(), { applicationServerKey: null });

  const { sessionToken } = await ownerSession(app);
  const challenge = await authed(app, API_ROUTES.pushChallenge, sessionToken, { hostId: 'x' });
  assert.equal(challenge.status, 503);
});

// --- subscribe -------------------------------------------------------------

test('subscribe round-trip persists the subscription owner-only', async () => {
  const { app, stateDir, host, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });

  const res = await subscribe(app, { sessionToken, host, client });
  assert.equal(res.status, 200);
  assert.equal(typeof (await res.json()).subscribedAt, 'number');

  const path = join(stateDir, 'push-subscriptions.json');
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].hostId, host.hostId);
  assert.equal(stored[0].devicePublicKey, client.deviceKey.devicePublicKey);
  // The endpoint plus its keys is a bearer capability to notify that phone.
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('subscribe requires a session', async () => {
  const { app, host } = await pushApp();
  const res = await post(app, API_ROUTES.pushSubscribe, { hostId: host.hostId });
  assert.equal(res.status, 401);
});

test('a signature from a different device is rejected', async () => {
  const { app, host, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });
  const impostor = await SimClient.create({ origin: ORIGIN });

  const challengeRes = await authed(app, API_ROUTES.pushChallenge, sessionToken, {
    hostId: host.hostId,
  });
  const { challenge } = await challengeRes.json();
  // Signed by the impostor, but claiming the real client's identity.
  const signature = await signPushSubscribe(impostor.deviceKey.privateKey, {
    hostId: host.hostId,
    challenge,
    devicePublicKey: client.deviceKey.devicePublicKey,
    endpoint: subscription().endpoint,
  });
  const res = await authed(app, API_ROUTES.pushSubscribe, sessionToken, {
    hostId: host.hostId,
    devicePublicKey: client.deviceKey.devicePublicKey,
    challenge,
    signature,
    subscription: subscription(),
  });
  assert.equal(res.status, 401);
});

test('a signature over a different endpoint is rejected', async () => {
  const { app, host, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });

  const challengeRes = await authed(app, API_ROUTES.pushChallenge, sessionToken, {
    hostId: host.hostId,
  });
  const { challenge } = await challengeRes.json();
  const signature = await signPushSubscribe(client.deviceKey.privateKey, {
    hostId: host.hostId,
    challenge,
    devicePublicKey: client.deviceKey.devicePublicKey,
    endpoint: 'https://push.example.com/sub/signed',
  });
  // Swapping the subscription under a good signature must not authenticate it.
  const res = await authed(app, API_ROUTES.pushSubscribe, sessionToken, {
    hostId: host.hostId,
    devicePublicKey: client.deviceKey.devicePublicKey,
    challenge,
    signature,
    subscription: subscription('https://push.example.com/sub/substituted'),
  });
  assert.equal(res.status, 401);
});

test('a challenge is single-use', async () => {
  const { app, host, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });

  const challengeRes = await authed(app, API_ROUTES.pushChallenge, sessionToken, {
    hostId: host.hostId,
  });
  const { challenge } = await challengeRes.json();
  const body = {
    hostId: host.hostId,
    devicePublicKey: client.deviceKey.devicePublicKey,
    challenge,
    signature: await signPushSubscribe(client.deviceKey.privateKey, {
      hostId: host.hostId,
      challenge,
      devicePublicKey: client.deviceKey.devicePublicKey,
      endpoint: subscription().endpoint,
    }),
    subscription: subscription(),
  };
  assert.equal((await authed(app, API_ROUTES.pushSubscribe, sessionToken, body)).status, 200);
  // Replaying the identical, still-valid request must fail on the challenge.
  assert.equal((await authed(app, API_ROUTES.pushSubscribe, sessionToken, body)).status, 400);
});

test('a malformed devicePublicKey is denied, not thrown', async () => {
  // The verifier decodes base64url from the body, so garbage must produce a
  // denial rather than an unhandled rejection on a session-token route.
  const { app, host, sessionToken } = await pushApp();
  const challengeRes = await authed(app, API_ROUTES.pushChallenge, sessionToken, {});
  const { challenge } = await challengeRes.json();
  const res = await authed(app, API_ROUTES.pushSubscribe, sessionToken, {
    hostId: host.hostId,
    devicePublicKey: 'not!valid!base64url',
    challenge,
    signature: 'also!garbage',
    subscription: subscription(),
  });
  assert.equal(res.status, 401);
});

test('a non-https endpoint is rejected', async () => {
  const { app, host, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });
  const res = await subscribe(app, {
    sessionToken,
    host,
    client,
    sub: subscription('http://192.168.1.1/internal'),
  });
  assert.equal(res.status, 400);
});

test('subscribing to an unknown host is rejected', async () => {
  const { app, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });
  const res = await subscribe(app, {
    sessionToken,
    host: { hostId: 'not-a-real-host' },
    client,
  });
  assert.equal(res.status, 404);
});

test('re-subscribing replaces the row rather than accumulating one per rotation', async () => {
  const { app, stateDir, host, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });

  await subscribe(app, { sessionToken, host, client, sub: subscription('https://push.example.com/1') });
  await subscribe(app, { sessionToken, host, client, sub: subscription('https://push.example.com/2') });

  const stored = JSON.parse(await readFile(join(stateDir, 'push-subscriptions.json'), 'utf8'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].endpoint, 'https://push.example.com/2');
});

// --- devices ---------------------------------------------------------------

test('devices lists this host subscribers by identity, never a label', async () => {
  const { app, host, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });
  await subscribe(app, { sessionToken, host, client });

  const res = await app.request(API_ROUTES.pushDevices, {
    headers: { Authorization: `Bearer ${host.hostToken}` },
  });
  assert.equal(res.status, 200);
  const { devices } = await res.json();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].devicePublicKey, client.deviceKey.devicePublicKey);
  // The Host holds the ACL; the Server must never learn a human name.
  assert.equal(devices[0].label, undefined);
});

test('a host cannot see another host subscribers', async () => {
  const { app, host, sessionToken } = await pushApp();
  const { body: other } = await enrollHost(app, { label: 'Other laptop' });
  const client = await SimClient.create({ origin: ORIGIN });
  await subscribe(app, { sessionToken, host, client });

  const res = await app.request(API_ROUTES.pushDevices, {
    headers: { Authorization: `Bearer ${other.hostToken}` },
  });
  assert.deepEqual(await res.json(), { devices: [] });
});

test('devices rejects a session token — it is host-gated', async () => {
  const { app, sessionToken } = await pushApp();
  const res = await app.request(API_ROUTES.pushDevices, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.status, 401);
});

// --- send ------------------------------------------------------------------

test('send fans out to every named device', async () => {
  const { app, sender, host, sessionToken } = await pushApp();
  const phone = await SimClient.create({ origin: ORIGIN });
  const tablet = await SimClient.create({ origin: ORIGIN });
  await subscribe(app, { sessionToken, host, client: phone, sub: subscription('https://push.example.com/phone') });
  await subscribe(app, { sessionToken, host, client: tablet, sub: subscription('https://push.example.com/tablet') });

  const res = await sendAs(app, host.hostToken, {
    devicePublicKeys: [phone.deviceKey.devicePublicKey, tablet.deviceKey.devicePublicKey],
    title: 'build finished',
    body: 'zsh',
    tag: 'pane-1',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { delivered: 2, expired: 0, unknown: 0 });
  assert.equal(sender.sent.length, 2);
  assert.deepEqual(JSON.parse(sender.sent[0].payload), {
    title: 'build finished',
    body: 'zsh',
    tag: 'pane-1',
  });
});

test('send without named devices is rejected — the Host must choose recipients', async () => {
  // The Host holds the ACL; a Server that picked recipients itself would keep
  // notifying a Client the Host had revoked.
  const { app, sender, host, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });
  await subscribe(app, { sessionToken, host, client });

  for (const body of [{ title: 'x', body: 'y' }, { devicePublicKeys: [], title: 'x', body: 'y' }]) {
    const res = await sendAs(app, host.hostToken, body);
    assert.equal(res.status, 400);
  }
  assert.equal(sender.sent.length, 0);
});

test('send addresses only the named devices', async () => {
  const { app, sender, host, sessionToken } = await pushApp();
  const phone = await SimClient.create({ origin: ORIGIN });
  const tablet = await SimClient.create({ origin: ORIGIN });
  await subscribe(app, { sessionToken, host, client: phone, sub: subscription('https://push.example.com/phone') });
  await subscribe(app, { sessionToken, host, client: tablet, sub: subscription('https://push.example.com/tablet') });

  const res = await sendAs(app, host.hostToken, {
    devicePublicKeys: [phone.deviceKey.devicePublicKey],
    title: 'x',
    body: 'y',
  });
  assert.deepEqual(await res.json(), { delivered: 1, expired: 0, unknown: 0 });
  assert.equal(sender.sent.length, 1);
  assert.equal(sender.sent[0].endpoint, 'https://push.example.com/phone');
});

test('a named device with no subscription counts as unknown, not delivered', async () => {
  const { app, host } = await pushApp();
  const res = await sendAs(app, host.hostToken, {
    devicePublicKeys: ['never-subscribed'],
    title: 'x',
    body: 'y',
  });
  assert.deepEqual(await res.json(), { delivered: 0, expired: 0, unknown: 1 });
});

test('a subscription the push service calls gone is dropped', async () => {
  const { app, sender, stateDir, host, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });
  await subscribe(app, { sessionToken, host, client, sub: subscription('https://push.example.com/dead') });
  sender.expire('https://push.example.com/dead');

  const res = await sendAs(app, host.hostToken, {
    devicePublicKeys: [client.deviceKey.devicePublicKey],
    title: 'x',
    body: 'y',
  });
  assert.deepEqual(await res.json(), { delivered: 0, expired: 1, unknown: 0 });

  const stored = JSON.parse(await readFile(join(stateDir, 'push-subscriptions.json'), 'utf8'));
  assert.deepEqual(stored, []);
});

test('a transient failure leaves the subscription in place', async () => {
  const { app, sender, stateDir, host, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });
  await subscribe(app, { sessionToken, host, client, sub: subscription('https://push.example.com/flaky') });
  sender.fail('https://push.example.com/flaky');

  const res = await sendAs(app, host.hostToken, {
    devicePublicKeys: [client.deviceKey.devicePublicKey],
    title: 'x',
    body: 'y',
  });
  assert.deepEqual(await res.json(), { delivered: 0, expired: 0, unknown: 0 });

  const stored = JSON.parse(await readFile(join(stateDir, 'push-subscriptions.json'), 'utf8'));
  assert.equal(stored.length, 1);
});

test('a host cannot push to another host subscribers', async () => {
  const { app, sender, host, sessionToken } = await pushApp();
  const { body: other } = await enrollHost(app, { label: 'Other laptop' });
  const client = await SimClient.create({ origin: ORIGIN });
  await subscribe(app, { sessionToken, host, client });

  // Naming the device explicitly must not escape the token's own host scope.
  const res = await sendAs(app, other.hostToken, {
    devicePublicKeys: [client.deviceKey.devicePublicKey],
    title: 'x',
    body: 'y',
  });
  assert.deepEqual(await res.json(), { delivered: 0, expired: 0, unknown: 1 });
  assert.equal(sender.sent.length, 0);
});

test('send rejects an unknown host token', async () => {
  const { app } = await pushApp();
  const res = await sendAs(app, 'not-a-host-token', { title: 'x', body: 'y' });
  assert.equal(res.status, 401);
});

test('payload text is bounded and collapsed at the server boundary', async () => {
  const { app, sender, host, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });
  await subscribe(app, { sessionToken, host, client });

  await sendAs(app, host.hostToken, {
    devicePublicKeys: [client.deviceKey.devicePublicKey],
    title: `${'x'.repeat(500)}`,
    body: 'a\n\n  b',
  });
  const payload = JSON.parse(sender.sent[0].payload);
  assert.equal(payload.title.length, 200);
  assert.equal(payload.body, 'a b');
});

test('control and bidi characters are stripped at the server boundary', async () => {
  // The Host already sanitizes, but this text is Pane-derived and therefore
  // terminal-supplied; both layers run the same shared rule.
  const { app, sender, host, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });
  await subscribe(app, { sessionToken, host, client });

  await sendAs(app, host.hostToken, {
    devicePublicKeys: [client.deviceKey.devicePublicKey],
    title: 'build\u0000finished',
    body: 'wat\u202ech',
  });
  const payload = JSON.parse(sender.sent[0].payload);
  assert.equal(payload.title, 'build finished');
  assert.equal(payload.body, 'watch');
});

test('an all-whitespace payload falls back rather than pushing an empty notification', async () => {
  const { app, sender, host, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });
  await subscribe(app, { sessionToken, host, client });

  await sendAs(app, host.hostToken, {
    devicePublicKeys: [client.deviceKey.devicePublicKey],
    title: '   ',
    body: '',
  });
  const payload = JSON.parse(sender.sent[0].payload);
  assert.equal(payload.title, 'Dormouse');
  assert.equal(payload.body, 'A terminal needs attention.');
});
