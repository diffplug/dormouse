/**
 * Request bodies are bounded before any route runs
 * (docs/specs/server.md -> HTTP API).
 *
 * The routes that matter are the unauthenticated ones — `/api/host/enroll`,
 * `/api/setup/*`, `/api/signin/finish` — which read their body BEFORE the
 * credential gate, so an unbounded reader lets any page on the tailnet make
 * the process buffer whatever it likes with no auth and no rate limit. The one
 * exception is `/api/push/send`, whose legitimate fan-out is larger than the
 * default and whose own cap is derived from the wire bounds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  API_ROUTES,
  DELIVERY_ID_LENGTH,
  MAX_PUSH_QUERY_DELIVERY_IDS,
  MAX_SEALED_PUSH_LENGTH,
  randomBase64Url,
} from 'remote-lib-common';

import { MAX_PUSH_SEND_BODY_BYTES, MAX_REQUEST_BODY_BYTES } from '../dist/app.js';
import { PASSWORD, enrollHost, fakePushSender, freshApp, ownerSession } from './helpers.mjs';

const VAPID_PUBLIC = 'BJxKIjEEuJH0dLHTAcMFVYRnLsIBWcuMt5S1FCdDLbxCkmpUuLfHTFzWSFCPFTFsFvT8sVFTFxKIjEE';

/** Raw POST: the body is a string this test controls byte for byte. */
function rawPost(app, path, body, headers = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

/** A JSON body padded past `bytes` with a field no route reads. */
function padded(bytes, fields = {}) {
  return JSON.stringify({ ...fields, pad: 'A'.repeat(bytes) });
}

test('an over-long body is 413 before the credential gate on every unauthenticated route', async () => {
  const { app } = await freshApp();
  const oversized = padded(MAX_REQUEST_BODY_BYTES + 1);

  for (const path of [
    API_ROUTES.hostEnroll,
    API_ROUTES.setupBegin,
    API_ROUTES.setupFinish,
    API_ROUTES.signinFinish,
  ]) {
    const res = await rawPost(app, path, oversized);
    // 413, not the 401 a rejected credential answers: the gate never ran.
    assert.equal(res.status, 413, path);
    assert.equal((await res.json()).error, 'request body too large');
  }
});

test('a correct credential inside an over-long body still 413s', async () => {
  // The bound is on the body, not on the caller: a valid setup password does
  // not buy the right to make the process buffer a gigabyte.
  const { app } = await freshApp();
  const res = await rawPost(
    app,
    API_ROUTES.hostEnroll,
    padded(MAX_REQUEST_BODY_BYTES + 1, { password: PASSWORD }),
  );
  assert.equal(res.status, 413);
});

test('a lying content-length is refused on the header alone', async () => {
  const { app } = await freshApp();
  const res = await rawPost(app, API_ROUTES.hostEnroll, JSON.stringify({ password: PASSWORD }), {
    'content-length': String(MAX_REQUEST_BODY_BYTES + 1),
  });
  assert.equal(res.status, 413);
});

test('an ordinary body is untouched by the limit', async () => {
  const { app } = await freshApp();
  const res = await rawPost(app, API_ROUTES.hostEnroll, JSON.stringify({ password: PASSWORD }));
  assert.equal(res.status, 200);
});

test('push send takes a full fan-out, which is larger than the default cap', async () => {
  const sender = fakePushSender();
  const { app } = await freshApp({ vapidPublicKey: VAPID_PUBLIC, pushSender: sender });
  const { body: host } = await enrollHost(app);
  await ownerSession(app);

  // The largest legal send: every recipient slot filled with a maximal envelope.
  const recipients = Array.from({ length: MAX_PUSH_QUERY_DELIVERY_IDS }, () => ({
    deliveryId: randomBase64Url(32),
    sealed: { v: 1, salt: randomBase64Url(32), ct: 'A'.repeat(MAX_SEALED_PUSH_LENGTH) },
  }));
  const body = JSON.stringify({ recipients });
  assert.ok(
    body.length > MAX_REQUEST_BODY_BYTES,
    'the case is only meaningful past the default cap',
  );
  assert.ok(body.length <= MAX_PUSH_SEND_BODY_BYTES, 'the derived cap admits a maximal fan-out');

  const res = await rawPost(app, API_ROUTES.pushSend, body, {
    Authorization: `Bearer ${host.hostToken}`,
  });
  assert.equal(res.status, 200);
  // No subscriptions exist, so every recipient is `unknown` — the point here is
  // that the body was read at all.
  assert.equal((await res.json()).unknown, MAX_PUSH_QUERY_DELIVERY_IDS);
});

test('push send is still bounded, one route-sized cap above the default', async () => {
  const sender = fakePushSender();
  const { app } = await freshApp({ vapidPublicKey: VAPID_PUBLIC, pushSender: sender });
  const { body: host } = await enrollHost(app);

  const res = await rawPost(app, API_ROUTES.pushSend, padded(MAX_PUSH_SEND_BODY_BYTES + 1), {
    Authorization: `Bearer ${host.hostToken}`,
  });
  assert.equal(res.status, 413);
  // Derived from the wire bounds, so it cannot drift away from what a maximal
  // fan-out actually costs.
  assert.equal(
    MAX_PUSH_SEND_BODY_BYTES,
    MAX_PUSH_QUERY_DELIVERY_IDS * (DELIVERY_ID_LENGTH + MAX_SEALED_PUSH_LENGTH + 256) + 256,
  );
});
