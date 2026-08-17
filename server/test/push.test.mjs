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
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { API_ROUTES, signPushSubscribe } from 'server-lib-common';
import webpush from 'web-push';

import { SimClient } from '../../server-lib-common/test/harness/actors.mjs';
import {
  PUSH_REQUEST_TIMEOUT_MS,
  assertVapidKeyPair,
  assertVapidSubject,
  createWebPushSender,
  generateVapidKeys,
} from '../dist/push.js';
import { ORIGIN, enrollHost, fakePushSender, freshApp, ownerSession, post } from './helpers.mjs';

const VAPID_PUBLIC = 'BJxKIjEEuJH0dLHTAcMFVYRnLsIBWcuMt5S1FCdDLbxCkmpUuLfHTFzWSFCPFTFsFvT8sVFTFxKIjEE';

test('VAPID validation rejects valid keys that do not form a pair', () => {
  const first = generateVapidKeys();
  const second = generateVapidKeys();

  assert.doesNotThrow(() => assertVapidKeyPair(first));
  assert.throws(
    () => assertVapidKeyPair({ publicKey: first.publicKey, privateKey: second.privateKey }),
    /matching keypair/,
  );
});

test('VAPID subject validation accepts contact URLs and rejects invalid values', () => {
  assert.doesNotThrow(() => assertVapidSubject('mailto:admin@example.com'));
  assert.doesNotThrow(() => assertVapidSubject('https://example.com/push-contact'));

  for (const subject of ['', 'admin@example.com', 'http://example.com/contact']) {
    assert.throws(() => assertVapidSubject(subject), /valid mailto: or https: URL/);
  }
});

test('real delivery gives push-service requests a bounded socket timeout', async () => {
  const originalSendNotification = webpush.sendNotification;
  let requestOptions;
  webpush.sendNotification = async (_subscription, _payload, options) => {
    requestOptions = options;
    return { statusCode: 201, body: '', headers: {} };
  };

  try {
    const sender = createWebPushSender(generateVapidKeys(), 'mailto:admin@example.com');
    const result = await sender.send(subscription(), '{}');
    assert.equal(result, 'delivered');
    assert.equal(requestOptions.timeout, PUSH_REQUEST_TIMEOUT_MS);
    assert.equal(PUSH_REQUEST_TIMEOUT_MS, 10_000);
  } finally {
    webpush.sendNotification = originalSendNotification;
  }
});

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

/**
 * Model a Server VAPID rotation while preserving the existing state file: the
 * stored endpoints are now unusable with the current signer, and every read
 * path must treat them as absent rather than as "Alerts on".
 */
async function rotateStoredVapidKey(stateDir) {
  const path = join(stateDir, 'push-subscriptions.json');
  const stored = JSON.parse(await readFile(path, 'utf8'));
  for (const row of stored) row.vapidPublicKey = 'BOldVapidPublicKey';
  await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`);
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
  assert.equal(stored[0].vapidPublicKey, VAPID_PUBLIC);
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

test('private and link-local https endpoints are rejected', async () => {
  const { app, host, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });

  for (const endpoint of [
    'https://127.0.0.1/push',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.1/internal',
    'https://[::1]/push',
  ]) {
    const res = await subscribe(app, {
      sessionToken,
      host,
      client,
      sub: subscription(endpoint),
    });
    assert.equal(res.status, 400, endpoint);
  }
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

test('rotating a device subscription invalidates its registrations for other Hosts', async () => {
  const { app, stateDir, host, sessionToken } = await pushApp();
  const { body: other } = await enrollHost(app, { label: 'Other laptop' });
  const client = await SimClient.create({ origin: ORIGIN });
  const original = subscription('https://push.example.com/original');

  assert.equal(
    (
      await subscribe(app, {
        sessionToken,
        host,
        client,
        sub: original,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await subscribe(app, {
        sessionToken,
        host: other,
        client,
        sub: original,
      })
    ).status,
    200,
  );

  const replacement = await subscribe(app, {
    sessionToken,
    host,
    client,
    sub: subscription('https://push.example.com/replacement'),
  });
  const replacementBody = await replacement.json();
  assert.equal(typeof replacementBody.subscribedAt, 'number');
  // The response is the device's whole surviving set, so the dropped sibling is
  // reported by its absence rather than by a flag the Client has to interpret.
  assert.deepEqual(replacementBody.hostIds, [host.hostId]);

  const stored = JSON.parse(await readFile(join(stateDir, 'push-subscriptions.json'), 'utf8'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].hostId, host.hostId);
  assert.equal(stored[0].endpoint, 'https://push.example.com/replacement');
});

test('subscribe answers with every Host this device is registered with', async () => {
  const { app, host, sessionToken } = await pushApp();
  const { body: other } = await enrollHost(app, { label: 'Other laptop' });
  const client = await SimClient.create({ origin: ORIGIN });
  const otherClient = await SimClient.create({ origin: ORIGIN });

  const first = await subscribe(app, { sessionToken, host, client });
  assert.deepEqual((await first.json()).hostIds, [host.hostId]);

  // Same address, second Host: both rows survive, and the answer grows.
  const second = await subscribe(app, { sessionToken, host: other, client });
  assert.deepEqual((await second.json()).hostIds.sort(), [host.hostId, other.hostId].sort());

  // Another device's rows are never mixed in — the response is scoped to the
  // identity that signed the request.
  const foreign = await subscribe(app, {
    sessionToken,
    host,
    client: otherClient,
    sub: subscription('https://push.example.com/other-device'),
  });
  assert.deepEqual((await foreign.json()).hostIds, [host.hostId]);
});

test('a retried subscribe whose first response was lost still reports the truth', async () => {
  // The Client cannot tell a lost response from a failed request, so it retries.
  // The mutation is idempotent and cannot re-announce the sibling rows it
  // already deleted — but it can always answer what is registered now, which is
  // what lets the Client repair its view without remembering what it did.
  const { app, host, sessionToken } = await pushApp();
  const { body: other } = await enrollHost(app, { label: 'Other laptop' });
  const client = await SimClient.create({ origin: ORIGIN });
  await subscribe(app, { sessionToken, host, client });
  await subscribe(app, { sessionToken, host: other, client });

  const rotated = subscription('https://push.example.com/rotated');
  const committed = await subscribe(app, { sessionToken, host, client, sub: rotated });
  assert.deepEqual((await committed.json()).hostIds, [host.hostId]);

  const retry = await subscribe(app, { sessionToken, host, client, sub: rotated });
  assert.equal(retry.status, 200);
  assert.deepEqual((await retry.json()).hostIds, [host.hostId]);
});

// --- subscriptions (client-facing) -----------------------------------------

test('subscriptions lets a reloaded client find the Hosts it already registered', async () => {
  const { app, host, sessionToken } = await pushApp();
  const { body: other } = await enrollHost(app, { label: 'Other laptop' });
  const client = await SimClient.create({ origin: ORIGIN });
  await subscribe(app, { sessionToken, host, client });

  const res = await app.request(API_ROUTES.pushSubscriptions, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.status, 200);
  const { subscriptions } = await res.json();
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].hostId, host.hostId);
  assert.equal(subscriptions[0].devicePublicKey, client.deviceKey.devicePublicKey);
  assert.equal(typeof subscriptions[0].subscribedAt, 'number');
  assert.notEqual(subscriptions[0].hostId, other.hostId);
});

test('subscriptions never returns the endpoint or its keys', async () => {
  // Those are a bearer capability to notify the phone; only identities leave.
  const { app, host, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });
  await subscribe(app, { sessionToken, host, client });

  const res = await app.request(API_ROUTES.pushSubscriptions, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  const body = await res.text();
  assert.equal(body.includes('push.example.com'), false);
  assert.equal(body.includes('FakeAuthSecret'), false);
  assert.equal(body.includes('BFakeP256dhKey'), false);
});

test('subscriptions hides rows registered under an old VAPID key', async () => {
  const { app, stateDir, host, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });
  await subscribe(app, { sessionToken, host, client });

  await rotateStoredVapidKey(stateDir);

  const res = await app.request(API_ROUTES.pushSubscriptions, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  assert.deepEqual(await res.json(), { subscriptions: [] });
});

test('subscriptions requires a session and rejects a host token', async () => {
  const { app, host } = await pushApp();
  assert.equal((await app.request(API_ROUTES.pushSubscriptions)).status, 401);
  const asHost = await app.request(API_ROUTES.pushSubscriptions, {
    headers: { Authorization: `Bearer ${host.hostToken}` },
  });
  assert.equal(asHost.status, 401);
});

test('subscriptions answers the truth rather than 503 when push is unconfigured', async () => {
  // Rows can outlive a key being removed, so an error would be a lie.
  const { app } = await freshApp();
  const { sessionToken } = await ownerSession(app);
  const res = await app.request(API_ROUTES.pushSubscriptions, {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { subscriptions: [] });
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

test('devices hides subscriptions registered under an old VAPID key', async () => {
  const { app, stateDir, host, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });
  await subscribe(app, { sessionToken, host, client });

  await rotateStoredVapidKey(stateDir);

  const res = await app.request(API_ROUTES.pushDevices, {
    headers: { Authorization: `Bearer ${host.hostToken}` },
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
  assert.deepEqual(await res.json(), { delivered: 2, expired: 0, unknown: 0, failed: 0 });
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
  assert.deepEqual(await res.json(), { delivered: 1, expired: 0, unknown: 0, failed: 0 });
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
  assert.deepEqual(await res.json(), { delivered: 0, expired: 0, unknown: 1, failed: 0 });
});

test('send treats a subscription registered under an old VAPID key as unknown', async () => {
  const { app, sender, stateDir, host, sessionToken } = await pushApp();
  const client = await SimClient.create({ origin: ORIGIN });
  await subscribe(app, { sessionToken, host, client });

  await rotateStoredVapidKey(stateDir);

  const res = await sendAs(app, host.hostToken, {
    devicePublicKeys: [client.deviceKey.devicePublicKey],
    title: 'x',
    body: 'y',
  });
  assert.deepEqual(await res.json(), { delivered: 0, expired: 0, unknown: 1, failed: 0 });
  assert.equal(sender.sent.length, 0);
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
  assert.deepEqual(await res.json(), { delivered: 0, expired: 1, unknown: 0, failed: 0 });

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
  assert.deepEqual(await res.json(), { delivered: 0, expired: 0, unknown: 0, failed: 1 });

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
  assert.deepEqual(await res.json(), { delivered: 0, expired: 0, unknown: 1, failed: 0 });
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
