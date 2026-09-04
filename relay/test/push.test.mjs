/**
 * Web Push subscriptions and delivery (docs/specs/alert.md -> Push
 * notifications, docs/specs/relay.md -> HTTP API).
 *
 * Rows are keyed on the pair (`hostId`, `deliveryId`), and the delivery id is
 * the whole authorization: 256 unguessable bits the Host minted at pairing and
 * handed to exactly one Client, so registering, querying and deleting need no
 * challenge and no signature. The cases that matter are the ones where a caller
 * must NOT learn about a row it does not already hold the capability for, and
 * where a Host must not reach another Host's subscribers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  API_ROUTES,
  MAX_PUSH_QUERY_DELIVERY_IDS,
  MAX_SEALED_PUSH_LENGTH,
  generateNoiseKeyPair,
  openPush,
  pushSubscriptionDeletePath,
  sealPush,
  randomBase64Url,
  utf8Decode,
  utf8Encode,
} from 'remote-lib-common';
import webpush from 'web-push';

import {
  PUSH_REQUEST_TIMEOUT_MS,
  assertVapidKeyPair,
  assertVapidSubject,
  createWebPushSender,
  defaultVapidSubject,
  generateVapidKeys,
} from '../dist/push.js';
import { MAX_PUSH_ENDPOINT_LENGTH } from '../dist/push-endpoint.js';
import {
  HostStore,
  MAX_PUSH_SUBSCRIPTIONS_PER_HOST,
  PushSubscriptionStore,
} from '../dist/state.js';
import { enrollHost, fakePushSender, freshApp, ownerSession, post } from './helpers.mjs';

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

// Apple answers 403 BadJwtToken for a loopback subject, so accepting one would
// boot a Relay that reports success and delivers nothing to any iPhone.
test('VAPID subject validation rejects loopback contacts', () => {
  for (const subject of [
    'mailto:admin@localhost',
    'mailto:admin@dev.localhost',
    'mailto:admin@127.0.0.1',
    'https://localhost:3000',
    'https://127.0.0.1:3000',
    'https://[::1]:3000',
  ]) {
    assert.throws(() => assertVapidSubject(subject), /loopback host/, subject);
  }
});

test('default VAPID subject is the https origin, and absent for one push cannot use', () => {
  assert.equal(
    defaultVapidSubject('https://dormouse.example.com'),
    'https://dormouse.example.com',
  );
  // Only the origin — a path or trailing slash is not part of the contact.
  assert.equal(
    defaultVapidSubject('https://dormouse.example.com/pocket/'),
    'https://dormouse.example.com',
  );

  // No usable contact → push off rather than a placeholder a service rejects.
  for (const origin of [
    'http://localhost:3000',
    'https://localhost:3000',
    'https://127.0.0.1:3000',
    'https://[::1]:3000',
    'http://dormouse.example.com',
    'not a url',
  ]) {
    assert.equal(defaultVapidSubject(origin), null, origin);
  }
});

function subscription(endpoint = 'https://push.example.com/sub/abc') {
  return { endpoint, keys: { p256dh: 'BFakeP256dhKey', auth: 'FakeAuthSecret' } };
}

/** A delivery id in the shape a Host mints: base64url of 32 random bytes. */
function newDeliveryId() {
  return randomBase64Url(32);
}

/** A fresh app with push configured, plus an enrolled host and a signed-in owner. */
async function pushApp(overrides = {}) {
  const sender = fakePushSender();
  const app = await freshApp({ vapidPublicKey: VAPID_PUBLIC, pushSender: sender, ...overrides });
  const { body: host } = await enrollHost(app.app);
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

/** Register `deliveryId` against `host`; there is no challenge and no signature. */
function subscribe(app, { sessionToken, host, deliveryId, sub = subscription() }) {
  return authed(app, API_ROUTES.pushSubscribe, sessionToken, {
    hostId: host.hostId,
    deliveryId,
    subscription: sub,
  });
}

function query(app, sessionToken, deliveryIds) {
  return authed(app, API_ROUTES.pushSubscriptionsQuery, sessionToken, { deliveryIds });
}

function removeDelivery(app, sessionToken, deliveryId) {
  return app.request(pushSubscriptionDeletePath(deliveryId), {
    method: 'DELETE',
    headers: sessionToken === undefined ? {} : { Authorization: `Bearer ${sessionToken}` },
  });
}

function sendAs(app, hostToken, body) {
  return authed(app, API_ROUTES.pushSend, hostToken, body);
}

/**
 * A well-formed sealed envelope with no real key behind it. The Relay can only
 * ever check shape and bounds — it holds no key and must not open one — so
 * every case that is about routing rather than about the seal uses this.
 */
function fakeSealed() {
  return { v: 1, salt: randomBase64Url(32), ct: randomBase64Url(96) };
}

/** A send body naming these deliveries, one distinct envelope each. */
function to(...deliveryIds) {
  return { recipients: deliveryIds.map((deliveryId) => ({ deliveryId, sealed: fakeSealed() })) };
}

function storedRows(stateDir) {
  return readFile(join(stateDir, 'push-subscriptions.json'), 'utf8').then(JSON.parse);
}

/**
 * Model a Relay VAPID rotation while preserving the existing state file: the
 * stored endpoints are now unusable with the current signer, and every read
 * path must treat them as absent rather than as "Push notifications on".
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
  const attempt = await subscribe(app, {
    sessionToken,
    host: { hostId: 'x' },
    deliveryId: newDeliveryId(),
  });
  assert.equal(attempt.status, 503);
});

// --- subscribe -------------------------------------------------------------

test('subscribe round-trip persists the subscription owner-only', async () => {
  const { app, stateDir, host, sessionToken } = await pushApp();
  const deliveryId = newDeliveryId();

  const res = await subscribe(app, { sessionToken, host, deliveryId });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.subscribedAt, 'number');
  assert.deepEqual(body.hostIds, [host.hostId]);

  const stored = await storedRows(stateDir);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].hostId, host.hostId);
  assert.equal(stored[0].deliveryId, deliveryId);
  assert.equal(stored[0].vapidPublicKey, VAPID_PUBLIC);
  assert.equal(stored[0].devicePublicKey, undefined, 'the device key is gone with its ceremony');
  // The endpoint plus its keys is a bearer capability to notify that phone.
  assert.equal((await stat(join(stateDir, 'push-subscriptions.json'))).mode & 0o777, 0o600);
});

test('subscribe requires a session', async () => {
  const { app, host } = await pushApp();
  const res = await post(app, API_ROUTES.pushSubscribe, {
    hostId: host.hostId,
    deliveryId: newDeliveryId(),
    subscription: subscription(),
  });
  assert.equal(res.status, 401);
});

test('a delivery id that is not 32 base64url bytes is refused before it becomes a key', async () => {
  const { app, host, sessionToken } = await pushApp();
  for (const deliveryId of [undefined, '', 'too-short', `${newDeliveryId()}x`, 'not!base64url!', 42]) {
    const res = await subscribe(app, { sessionToken, host, deliveryId });
    assert.equal(res.status, 400, String(deliveryId));
  }
});

test('a non-https endpoint is rejected', async () => {
  const { app, host, sessionToken } = await pushApp();
  const res = await subscribe(app, {
    sessionToken,
    host,
    deliveryId: newDeliveryId(),
    sub: subscription('http://192.168.1.1/internal'),
  });
  assert.equal(res.status, 400);
});

test('private and link-local https endpoints are rejected', async () => {
  const { app, host, sessionToken } = await pushApp();
  for (const endpoint of [
    'https://127.0.0.1/push',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.1/internal',
    'https://[::1]/push',
  ]) {
    const res = await subscribe(app, {
      sessionToken,
      host,
      deliveryId: newDeliveryId(),
      sub: subscription(endpoint),
    });
    assert.equal(res.status, 400, endpoint);
  }
});

test('subscribing to an unknown host is rejected', async () => {
  const { app, sessionToken } = await pushApp();
  const res = await subscribe(app, {
    sessionToken,
    host: { hostId: 'not-a-real-host' },
    deliveryId: newDeliveryId(),
  });
  assert.equal(res.status, 404);
});

// --- every stored field is bounded, and so is the row count ----------------
// A durable row of unknown size is re-read and re-parsed by every push route,
// and `deliveryId` is the caller's own choice, so an unbounded field or an
// uncapped file turns one signed-in request into permanent degradation
// (`docs/specs/relay.md` -> State files).

test('an over-long endpoint is refused before it becomes a durable row', async () => {
  const { app, stateDir, host, sessionToken } = await pushApp();
  const endpoint = `https://push.example.com/sub/${'a'.repeat(MAX_PUSH_ENDPOINT_LENGTH)}`;

  const res = await subscribe(app, {
    sessionToken,
    host,
    deliveryId: newDeliveryId(),
    sub: subscription(endpoint),
  });

  assert.equal(res.status, 400);
  await assert.rejects(storedRows(stateDir), 'nothing was written');
});

test('over-long encryption keys are refused; RFC 8291 fixes both lengths', async () => {
  const { app, stateDir, host, sessionToken } = await pushApp();
  const long = 'A'.repeat(4096);

  for (const keys of [
    { p256dh: long, auth: 'FakeAuthSecret' },
    { p256dh: 'BFakeP256dhKey', auth: long },
    // Empty is not a key `web-push` could ever encrypt to.
    { p256dh: '', auth: 'FakeAuthSecret' },
    { p256dh: 'BFakeP256dhKey', auth: '' },
  ]) {
    const res = await subscribe(app, {
      sessionToken,
      host,
      deliveryId: newDeliveryId(),
      sub: { endpoint: 'https://push.example.com/sub/abc', keys },
    });
    assert.equal(res.status, 400, JSON.stringify(keys).slice(0, 40));
  }
  await assert.rejects(storedRows(stateDir), 'nothing was written');
});

test('a padded base64 p256dh still registers — browsers serialize both ways', async () => {
  const { app, host, sessionToken } = await pushApp();
  const res = await subscribe(app, {
    sessionToken,
    host,
    deliveryId: newDeliveryId(),
    // 65 and 16 raw bytes as PADDED base64: the longest either can really be.
    sub: {
      endpoint: 'https://push.example.com/sub/abc',
      keys: { p256dh: `${'B'.repeat(87)}=`, auth: `${'C'.repeat(23)}=` },
    },
  });
  assert.equal(res.status, 200);
});

test('the per-host row cap evicts the oldest subscription, never the new one', async () => {
  const { app, stateDir, host, sessionToken } = await pushApp();
  const ids = [];
  // One past the cap, each a fresh delivery id and a fresh endpoint — the shape
  // a caller minting its own ids produces.
  for (let i = 0; i <= MAX_PUSH_SUBSCRIPTIONS_PER_HOST; i += 1) {
    const deliveryId = newDeliveryId();
    ids.push(deliveryId);
    const res = await subscribe(app, {
      sessionToken,
      host,
      deliveryId,
      sub: subscription(`https://push.example.com/sub/${i}`),
    });
    assert.equal(res.status, 200);
  }

  const stored = await storedRows(stateDir);
  assert.equal(stored.length, MAX_PUSH_SUBSCRIPTIONS_PER_HOST);
  const kept = new Set(stored.map((row) => row.deliveryId));
  assert.equal(kept.has(ids[0]), false, 'the oldest row was evicted');
  assert.equal(kept.has(ids.at(-1)), true, 'the row just committed survives');
});

test('re-subscribing replaces the row rather than accumulating one per rotation', async () => {
  const { app, stateDir, host, sessionToken } = await pushApp();
  const deliveryId = newDeliveryId();

  await subscribe(app, { sessionToken, host, deliveryId, sub: subscription('https://push.example.com/1') });
  await subscribe(app, { sessionToken, host, deliveryId, sub: subscription('https://push.example.com/2') });

  const stored = await storedRows(stateDir);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].endpoint, 'https://push.example.com/2');
});

test('rotating the endpoint drops every row still carrying the replaced one', async () => {
  // One worker scope has one address, so a delivery whose endpoint changed
  // means every row still on the old endpoint — whichever Host, whichever
  // delivery id — points somewhere the browser no longer listens.
  const { app, stateDir, host, sessionToken } = await pushApp();
  const { body: other } = await enrollHost(app);
  const original = subscription('https://push.example.com/original');
  const forHost = newDeliveryId();
  const forOther = newDeliveryId();

  assert.equal((await subscribe(app, { sessionToken, host, deliveryId: forHost, sub: original })).status, 200);
  assert.equal(
    (await subscribe(app, { sessionToken, host: other, deliveryId: forOther, sub: original })).status,
    200,
  );

  const replacement = await subscribe(app, {
    sessionToken,
    host,
    deliveryId: forHost,
    sub: subscription('https://push.example.com/replacement'),
  });
  const body = await replacement.json();
  assert.equal(typeof body.subscribedAt, 'number');
  // The response is the surviving set for the presented endpoint, so the
  // dropped sibling is reported by its absence rather than by a flag.
  assert.deepEqual(body.hostIds, [host.hostId]);

  const stored = await storedRows(stateDir);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].hostId, host.hostId);
  assert.equal(stored[0].deliveryId, forHost);
  assert.equal(stored[0].endpoint, 'https://push.example.com/replacement');
});

test('a moved delivery drops its own stale rows under every Host that holds it', async () => {
  // The addresses a subscribe replaces are read from every row carrying this
  // delivery id, not only the row for this Host. A delivery id names one
  // Client's pairing, so any row holding it speaks for the same worker scope —
  // and reading only `(hostId, deliveryId)` left a sibling row sitting on an
  // address the browser had already moved off, which the possession query then
  // reported as registered.
  const { app, stateDir, host, sessionToken } = await pushApp();
  const { body: other } = await enrollHost(app);
  const deliveryId = newDeliveryId();
  const old = subscription('https://push.example.com/old');

  assert.equal(
    (await subscribe(app, { sessionToken, host: other, deliveryId, sub: old })).status,
    200,
  );
  // A different Host, the same delivery, a new address: this Host has no row of
  // its own to read the replaced endpoint from.
  const moved = await subscribe(app, {
    sessionToken,
    host,
    deliveryId,
    sub: subscription('https://push.example.com/new'),
  });
  assert.deepEqual((await moved.json()).hostIds, [host.hostId]);

  const stored = await storedRows(stateDir);
  assert.deepEqual(
    stored.map((row) => row.endpoint),
    ['https://push.example.com/new'],
  );
  // And the query no longer reports the dead address as registered.
  const answered = await (await query(app, sessionToken, [deliveryId])).json();
  assert.deepEqual(answered.registered, [{ hostId: host.hostId, deliveryId }]);
});

test('subscribe answers every Host whose rows carry the presented endpoint', async () => {
  const { app, host, sessionToken } = await pushApp();
  const { body: other } = await enrollHost(app);
  const forHost = newDeliveryId();
  const forOther = newDeliveryId();

  const first = await subscribe(app, { sessionToken, host, deliveryId: forHost });
  assert.deepEqual((await first.json()).hostIds, [host.hostId]);

  // Same address, second Host: both rows survive, and the answer grows.
  const second = await subscribe(app, { sessionToken, host: other, deliveryId: forOther });
  assert.deepEqual((await second.json()).hostIds.sort(), [host.hostId, other.hostId].sort());

  // A different phone's rows are never mixed in — the answer is scoped to the
  // endpoint that was presented, not to the account.
  const foreign = await subscribe(app, {
    sessionToken,
    host,
    deliveryId: newDeliveryId(),
    sub: subscription('https://push.example.com/other-phone'),
  });
  assert.deepEqual((await foreign.json()).hostIds, [host.hostId]);
});

test('a retried subscribe whose first response was lost still reports the truth', async () => {
  // The Client cannot tell a lost response from a failed request, so it retries.
  // The mutation is idempotent and cannot re-announce the sibling rows it
  // already deleted — but it can always answer what is registered now, which is
  // what lets the Client repair its view without remembering what it did.
  const { app, host, sessionToken } = await pushApp();
  const { body: other } = await enrollHost(app);
  const forHost = newDeliveryId();
  const forOther = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId: forHost });
  await subscribe(app, { sessionToken, host: other, deliveryId: forOther });

  const rotated = subscription('https://push.example.com/rotated');
  const committed = await subscribe(app, { sessionToken, host, deliveryId: forHost, sub: rotated });
  assert.deepEqual((await committed.json()).hostIds, [host.hostId]);

  const retry = await subscribe(app, { sessionToken, host, deliveryId: forHost, sub: rotated });
  assert.equal(retry.status, 200);
  assert.deepEqual((await retry.json()).hostIds, [host.hostId]);
});

// --- subscriptions/query (client-facing, capability-parameterized) ----------

test('query reports the presented ids, and never one the caller did not name', async () => {
  const { app, host, sessionToken } = await pushApp();
  const { body: other } = await enrollHost(app);
  const mine = newDeliveryId();
  const someone = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId: mine });
  await subscribe(app, {
    sessionToken,
    host: other,
    deliveryId: someone,
    sub: subscription('https://push.example.com/someone'),
  });

  const res = await query(app, sessionToken, [mine]);
  assert.equal(res.status, 200);
  // The account owns both rows and the session is the same one — possession of
  // the id is what the answer is scoped to, which is the whole point of keying
  // the read on a capability instead of an identity.
  assert.deepEqual(await res.json(), { registered: [{ hostId: host.hostId, deliveryId: mine }] });

  const unnamed = await query(app, sessionToken, [newDeliveryId()]);
  assert.deepEqual(await unnamed.json(), { registered: [] });
});

test('query is bounded, and requires a session', async () => {
  const { app, host, sessionToken } = await pushApp();
  const deliveryId = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId });

  for (const deliveryIds of [
    undefined,
    [],
    'not-an-array',
    [42],
    Array.from({ length: MAX_PUSH_QUERY_DELIVERY_IDS + 1 }, newDeliveryId),
  ]) {
    const res = await query(app, sessionToken, deliveryIds);
    assert.equal(res.status, 400, JSON.stringify(deliveryIds)?.slice(0, 40));
  }
  assert.equal((await post(app, API_ROUTES.pushSubscriptionsQuery, { deliveryIds: [deliveryId] })).status, 401);
});

test('query hides rows registered under an old VAPID key', async () => {
  const { app, stateDir, host, sessionToken } = await pushApp();
  const deliveryId = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId });

  await rotateStoredVapidKey(stateDir);

  const res = await query(app, sessionToken, [deliveryId]);
  assert.deepEqual(await res.json(), { registered: [] });
});

// --- DELETE /api/push/subscriptions/:deliveryId ------------------------------

test('deleting is idempotent and answers 204 whether or not a row existed', async () => {
  const { app, stateDir, host, sessionToken } = await pushApp();
  const { body: other } = await enrollHost(app);
  const deliveryId = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId });
  await subscribe(app, { sessionToken, host: other, deliveryId });

  const live = await removeDelivery(app, sessionToken, deliveryId);
  assert.equal(live.status, 204);
  assert.equal(await live.text(), '');
  // Every row carrying that id goes, across Hosts: the capability is what the
  // Client is forgetting, not one Host's registration.
  assert.deepEqual(await storedRows(stateDir), []);

  // A repeat and an id that never existed answer identically — the route must
  // not become an oracle for whether a guessed id names a row.
  assert.equal((await removeDelivery(app, sessionToken, deliveryId)).status, 204);
  assert.equal((await removeDelivery(app, sessionToken, newDeliveryId())).status, 204);
  assert.equal((await removeDelivery(app, sessionToken, 'not-even-an-id')).status, 204);

  assert.equal((await removeDelivery(app, undefined, deliveryId)).status, 401);
});

// --- devices ---------------------------------------------------------------

test('devices lists this host subscribers by delivery id, never a label', async () => {
  const { app, host, sessionToken } = await pushApp();
  const deliveryId = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId });

  const res = await app.request(API_ROUTES.pushDevices, {
    headers: { Authorization: `Bearer ${host.hostToken}` },
  });
  assert.equal(res.status, 200);
  const { devices } = await res.json();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].deliveryId, deliveryId);
  assert.equal(typeof devices[0].subscribedAt, 'number');
  // The Host holds the ACL; the Relay must never learn a human name.
  assert.equal(devices[0].label, undefined);
});

test('a host cannot see another host subscribers', async () => {
  const { app, host, sessionToken } = await pushApp();
  const { body: other } = await enrollHost(app);
  await subscribe(app, { sessionToken, host, deliveryId: newDeliveryId() });

  const res = await app.request(API_ROUTES.pushDevices, {
    headers: { Authorization: `Bearer ${other.hostToken}` },
  });
  assert.deepEqual(await res.json(), { devices: [] });
});

test('devices hides subscriptions registered under an old VAPID key', async () => {
  const { app, stateDir, host, sessionToken } = await pushApp();
  await subscribe(app, { sessionToken, host, deliveryId: newDeliveryId() });

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
//
// Every send carries one sealed envelope per recipient and no readable text:
// the Host seals to each Client's own static and the Relay forwards ciphertext
// (docs/specs/remote-security-model.md -> Push sealing). What it can still
// check is shape, bounds, and that a Host reaches only its own subscribers.

test('send fans out to every named delivery', async () => {
  const { app, sender, host, sessionToken } = await pushApp();
  const phone = newDeliveryId();
  const tablet = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId: phone, sub: subscription('https://push.example.com/phone') });
  await subscribe(app, { sessionToken, host, deliveryId: tablet, sub: subscription('https://push.example.com/tablet') });

  const recipients = [
    { deliveryId: phone, sealed: fakeSealed() },
    { deliveryId: tablet, sealed: fakeSealed() },
  ];
  const res = await sendAs(app, host.hostToken, { recipients });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { delivered: 2, expired: 0, unknown: 0, failed: 0 });
  assert.equal(sender.sent.length, 2);
  // Each phone gets its own envelope, verbatim, under the sending Host's id.
  for (const [i, recipient] of recipients.entries()) {
    assert.deepEqual(JSON.parse(sender.sent[i].payload), {
      hostId: host.hostId,
      ...recipient.sealed,
    });
  }
});

test('the forwarded payload is the sealed envelope and nothing else', async () => {
  // Sealed for real, so the assertion is against what a Host actually mints:
  // the Relay holds no key, cannot open it, and must not add, drop, or
  // re-encode a field on the way through.
  const { app, sender, host, sessionToken } = await pushApp();
  const deliveryId = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId });

  const hostStatic = await generateNoiseKeyPair();
  const clientStatic = await generateNoiseKeyPair();
  const plaintext = utf8Encode(JSON.stringify({ title: 'build finished', body: 'zsh', tag: 'pty-1' }));
  const sealed = await sealPush({
    hostStaticPrivateKey: hostStatic.privateKey,
    clientStaticPublicKey: clientStatic.publicKey,
    plaintext,
  });

  await sendAs(app, host.hostToken, { recipients: [{ deliveryId, sealed }] });
  const payload = sender.sent[0].payload;
  assert.equal(payload, JSON.stringify({ hostId: host.hostId, ...sealed }));
  // The whole point: none of the notification text survives to this boundary.
  for (const secret of ['build finished', 'zsh', 'pty-1']) {
    assert.equal(payload.includes(secret), false, secret);
  }
  // And what did arrive still opens on the recipient's key.
  const opened = await openPush({
    clientStaticPrivateKey: clientStatic.privateKey,
    hostStaticPublicKey: hostStatic.publicKey,
    sealed: JSON.parse(payload),
  });
  assert.equal(utf8Decode(opened), utf8Decode(plaintext));
});

test('an extra field on the envelope reaches no phone, not even the hostId', async () => {
  // `isSealedPushV1` bounds the three fields it knows and ignores the rest, so
  // the route must copy those three rather than spread — a spread would let a
  // Host override the token's `hostId` and smuggle readable text through a
  // Relay that holds no key and must forward neither (docs/specs/security-remote.md -> "What
  // crosses the boundary").
  const { app, sender, host, sessionToken } = await pushApp();
  const deliveryId = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId });

  const sealed = { ...fakeSealed(), hostId: 'AAAAAAAAAAAAAAAAAAAAAA', title: 'build finished' };
  await sendAs(app, host.hostToken, { recipients: [{ deliveryId, sealed }] });

  const forwarded = JSON.parse(sender.sent[0].payload);
  assert.deepEqual(Object.keys(forwarded).sort(), ['ct', 'hostId', 'salt', 'v']);
  assert.equal(forwarded.hostId, host.hostId);
  assert.equal(sender.sent[0].payload.includes('build finished'), false);
});

test('send without recipients is rejected — the Host must choose them', async () => {
  // The Host holds the ACL; a Relay that picked recipients itself would keep
  // notifying a Client the Host had revoked.
  const { app, sender, host, sessionToken } = await pushApp();
  await subscribe(app, { sessionToken, host, deliveryId: newDeliveryId() });

  for (const body of [{}, { recipients: [] }, { recipients: 'all' }]) {
    const res = await sendAs(app, host.hostToken, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(sender.sent.length, 0);
});

test('send bounds the recipient list and every envelope in it', async () => {
  const { app, sender, host, sessionToken } = await pushApp();
  const deliveryId = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId });
  const good = fakeSealed();

  const tooMany = Array.from({ length: MAX_PUSH_QUERY_DELIVERY_IDS + 1 }, () => ({
    deliveryId: newDeliveryId(),
    sealed: fakeSealed(),
  }));
  assert.equal((await sendAs(app, host.hostToken, { recipients: tooMany })).status, 400);

  // `readJson` caps nothing and the envelope is forwarded verbatim, so its
  // bounds are the Relay's only defense against a huge push payload.
  for (const sealed of [
    undefined,
    { ...good, v: 2 },
    { ...good, salt: `${good.salt}A` },
    { ...good, ct: 'A'.repeat(MAX_SEALED_PUSH_LENGTH + 1) },
    { ...good, ct: '' },
    { salt: good.salt, ct: good.ct },
  ]) {
    const res = await sendAs(app, host.hostToken, { recipients: [{ deliveryId, sealed }] });
    assert.equal(res.status, 400, JSON.stringify(sealed));
  }
  assert.equal(sender.sent.length, 0);
});

test('send addresses only the named deliveries', async () => {
  const { app, sender, host, sessionToken } = await pushApp();
  const phone = newDeliveryId();
  const tablet = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId: phone, sub: subscription('https://push.example.com/phone') });
  await subscribe(app, { sessionToken, host, deliveryId: tablet, sub: subscription('https://push.example.com/tablet') });

  const res = await sendAs(app, host.hostToken, to(phone));
  assert.deepEqual(await res.json(), { delivered: 1, expired: 0, unknown: 0, failed: 0 });
  assert.equal(sender.sent.length, 1);
  assert.equal(sender.sent[0].endpoint, 'https://push.example.com/phone');
});

test('a named delivery with no subscription counts as unknown, not delivered', async () => {
  const { app, host } = await pushApp();
  const res = await sendAs(app, host.hostToken, to(newDeliveryId()));
  assert.deepEqual(await res.json(), { delivered: 0, expired: 0, unknown: 1, failed: 0 });
});

// Every route that names a delivery id bounds it the way subscribe does. A
// value no Host could have minted names no row, and `readJson` caps nothing —
// so the bound is what keeps a session-holder from posting megabytes that get
// hashed into a Set and compared against every stored row.
test('every delivery-id route refuses an id no Host could have minted', async () => {
  const { app, host, sessionToken } = await pushApp();
  // Hundreds of times the legal length, but inside `MAX_REQUEST_BODY_BYTES`:
  // past that the body limit refuses it with a 413 first, which is what
  // `body-limit.test.mjs` covers.
  const oversized = 'A'.repeat(10_000);
  for (const bad of ['never-subscribed', oversized, `${newDeliveryId()}x`]) {
    assert.equal((await query(app, sessionToken, [bad])).status, 400, `query ${bad.length}`);
    const sent = await sendAs(app, host.hostToken, to(bad));
    assert.equal(sent.status, 400, `send ${bad.length}`);
  }
  // The delete stays idempotent-and-silent whatever it is handed: answering a
  // malformed id differently would make the route an oracle.
  const deleted = await removeDelivery(app, sessionToken, 'never-subscribed');
  assert.equal(deleted.status, 204);
});

test('send treats a subscription registered under an old VAPID key as unknown', async () => {
  const { app, sender, stateDir, host, sessionToken } = await pushApp();
  const deliveryId = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId });

  await rotateStoredVapidKey(stateDir);

  const res = await sendAs(app, host.hostToken, to(deliveryId));
  assert.deepEqual(await res.json(), { delivered: 0, expired: 0, unknown: 1, failed: 0 });
  assert.equal(sender.sent.length, 0);
});

test('a subscription the push service calls gone is dropped', async () => {
  const { app, sender, stateDir, host, sessionToken } = await pushApp();
  const deliveryId = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId, sub: subscription('https://push.example.com/dead') });
  sender.expire('https://push.example.com/dead');

  const res = await sendAs(app, host.hostToken, to(deliveryId));
  assert.deepEqual(await res.json(), { delivered: 0, expired: 1, unknown: 0, failed: 0 });

  assert.deepEqual(await storedRows(stateDir), []);
});

test('a transient failure leaves the subscription in place', async () => {
  const { app, sender, stateDir, host, sessionToken } = await pushApp();
  const deliveryId = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId, sub: subscription('https://push.example.com/flaky') });
  sender.fail('https://push.example.com/flaky');

  const res = await sendAs(app, host.hostToken, to(deliveryId));
  assert.deepEqual(await res.json(), { delivered: 0, expired: 0, unknown: 0, failed: 1 });

  assert.equal((await storedRows(stateDir)).length, 1);
});

test('a send that never answers is bounded and leaves the subscription in place', async () => {
  // A push service can accept the connection and then go quiet, which resets
  // the socket-inactivity timer forever. Without a wall-clock bound the handler
  // stays open and successive alarms stack concurrent sends on top of it.
  const { app, sender, stateDir, host, sessionToken } = await pushApp({ pushSendDeadlineMs: 30 });
  const deliveryId = newDeliveryId();
  const endpoint = 'https://push.example.com/wedged';
  await subscribe(app, { sessionToken, host, deliveryId, sub: subscription(endpoint) });
  sender.hang(endpoint);

  const res = await sendAs(app, host.hostToken, to(deliveryId));
  // Transient, like any other failure — so the row survives to be retried,
  // rather than being pruned the way a 404/410 would prune it.
  assert.deepEqual(await res.json(), { delivered: 0, expired: 0, unknown: 0, failed: 1 });
  assert.equal((await storedRows(stateDir)).length, 1);
});

test('one wedged device does not hold up the rest of the fan-out', async () => {
  const { app, sender, host, sessionToken } = await pushApp({ pushSendDeadlineMs: 30 });
  const wedged = newDeliveryId();
  const healthy = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId: wedged, sub: subscription('https://push.example.com/wedged') });
  await subscribe(app, { sessionToken, host, deliveryId: healthy, sub: subscription('https://push.example.com/healthy') });
  sender.hang('https://push.example.com/wedged');

  const res = await sendAs(app, host.hostToken, to(wedged, healthy));
  assert.deepEqual(await res.json(), { delivered: 1, expired: 0, unknown: 0, failed: 1 });
});

test('a host cannot push to another host subscribers', async () => {
  const { app, sender, host, sessionToken } = await pushApp();
  const { body: other } = await enrollHost(app);
  const deliveryId = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId });

  // Naming the delivery explicitly must not escape the token's own host scope.
  const res = await sendAs(app, other.hostToken, to(deliveryId));
  assert.deepEqual(await res.json(), { delivered: 0, expired: 0, unknown: 1, failed: 0 });
  assert.equal(sender.sent.length, 0);
});

test('send rejects an unknown host token', async () => {
  const { app } = await pushApp();
  const res = await sendAs(app, 'not-a-host-token', to(newDeliveryId()));
  assert.equal(res.status, 401);
});

// --- the hosts.json cascade -------------------------------------------------

test('a row whose Host is no longer enrolled is dropped on read', async () => {
  // Deleting a line from `hosts.json` is the documented revocation mechanism,
  // so a subscription registered against that Host must stop being reported as
  // live — Pocket would otherwise show push as on for a machine that is gone.
  const { app, stateDir, host, sessionToken } = await pushApp();
  const deliveryId = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId });
  assert.deepEqual(await (await query(app, sessionToken, [deliveryId])).json(), {
    registered: [{ hostId: host.hostId, deliveryId }],
  });

  // A second Host survives the edit, so the row that goes is the orphan.
  const { body: survivor } = await enrollHost(app);
  const survivorDelivery = newDeliveryId();
  const hosts = JSON.parse(await readFile(join(stateDir, 'hosts.json'), 'utf8'));
  await writeFile(
    join(stateDir, 'hosts.json'),
    `${JSON.stringify(hosts.filter((h) => h.hostId !== host.hostId), null, 2)}\n`,
  );

  // Read fresh, so revoking a Host takes effect without a restart.
  assert.deepEqual(await (await query(app, sessionToken, [deliveryId])).json(), {
    registered: [],
  });
  // And the next mutation writes the pruned set back to disk.
  await subscribe(app, {
    sessionToken,
    host: survivor,
    deliveryId: survivorDelivery,
    sub: subscription('https://push.example.com/survivor'),
  });
  assert.deepEqual(
    (await storedRows(stateDir)).map((row) => row.deliveryId),
    [survivorDelivery],
  );
});

test('a `hosts.json` absent for an instant revokes nobody, and truncates nothing', async () => {
  // An editor saves by rename, so the file is briefly absent — the same
  // absent-vs-empty distinction the relay's revocation sweep makes. Emptying
  // the array is the revocation; losing the file for an instant is not.
  const { app, stateDir, host, sessionToken } = await pushApp();
  const deliveryId = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId });

  const path = join(stateDir, 'hosts.json');
  const hosts = await readFile(path, 'utf8');
  await rm(path);

  assert.deepEqual(await (await query(app, sessionToken, [deliveryId])).json(), {
    registered: [{ hostId: host.hostId, deliveryId }],
  });

  // And the read that matters most is the one `upsert` writes back: joining
  // against an empty enrolled set would not hide the rows, it would delete
  // them. The routes 404 a subscribe while the file is gone, so this is the
  // store's own guarantee, held whatever a future caller reaches it through.
  const store = new PushSubscriptionStore(stateDir, () => Date.now(), new HostStore(stateDir));
  const second = newDeliveryId();
  await store.upsert({
    hostId: host.hostId,
    deliveryId: second,
    ...subscription('https://push.example.com/second'),
    vapidPublicKey: VAPID_PUBLIC,
  });
  assert.deepEqual(
    (await storedRows(stateDir)).map((row) => row.deliveryId).sort(),
    [deliveryId, second].sort(),
  );

  // Restored with the row gone, the cascade still fires.
  await writeFile(path, JSON.stringify(JSON.parse(hosts).filter(() => false)));
  assert.deepEqual(await (await query(app, sessionToken, [deliveryId])).json(), {
    registered: [],
  });
});

// --- rows this Relay cannot use --------------------------------------------
//
// The ONLY case in this file that puts an unusable row on disk, because the
// store's warning fires once per process: a second row-dropping test would
// depend on declaration order to see it.

test('a pre-cutover or hand-mangled row is dropped on read, with exactly one warning', async () => {
  const { app, stateDir, host, sessionToken } = await pushApp();
  const deliveryId = newDeliveryId();
  await subscribe(app, { sessionToken, host, deliveryId });
  const path = join(stateDir, 'push-subscriptions.json');

  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    // A row written before the end-to-end cutover: a device key and no delivery
    // id. There is no migration reader — it reads as a missing registration,
    // which Pocket repairs by re-offering Enable.
    const [row] = await storedRows(stateDir);
    delete row.deliveryId;
    row.devicePublicKey = 'BLegacyDeviceKey';
    await writeFile(path, `${JSON.stringify([row], null, 2)}\n`);

    assert.deepEqual(await (await query(app, sessionToken, [deliveryId])).json(), {
      registered: [],
    });
    const dropped = warnings.filter((w) => w.includes('push-subscriptions.json'));
    assert.equal(dropped.length, 1);
    assert.match(dropped[0], /Re-register push/);

    // A hand-edited row missing its encryption keys is dropped the same way,
    // and the operator is not told twice.
    await writeFile(path, `${JSON.stringify([{ ...row, deliveryId, keys: undefined }], null, 2)}\n`);
    assert.deepEqual(await (await query(app, sessionToken, [deliveryId])).json(), {
      registered: [],
    });
    assert.equal(warnings.filter((w) => w.includes('push-subscriptions.json')).length, 1);
  } finally {
    console.warn = realWarn;
  }

  // And re-subscribing over it succeeds instead of throwing out of the route.
  const repair = await subscribe(app, { sessionToken, host, deliveryId });
  assert.equal(repair.status, 200);
  assert.deepEqual((await repair.json()).hostIds, [host.hostId]);
});
