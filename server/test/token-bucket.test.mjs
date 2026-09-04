import { test } from 'node:test';
import assert from 'node:assert/strict';

import { API_ROUTES } from 'server-lib-common';

import {
  HOST_ENROLL_ATTEMPT_BURST,
  HOST_ENROLL_ATTEMPT_REFILL_MS,
  MAX_REQUEST_BODY_BYTES,
} from '../dist/app.js';
import { TokenBucket } from '../dist/token-bucket.js';
import { freshApp, makeClock, post } from './helpers.mjs';

test('the bucket admits one burst, then refills one token per interval', () => {
  const clock = makeClock();
  const bucket = new TokenBucket({ capacity: 2, refillIntervalMs: 1_000, now: clock.now });

  assert.equal(bucket.take(), null);
  assert.equal(bucket.take(), null);
  assert.equal(bucket.take(), 1_000);
  clock.advance(999);
  assert.equal(bucket.take(), 1);
  clock.advance(1);
  assert.equal(bucket.take(), null);
  assert.equal(bucket.take(), 1_000);
  clock.advance(10_000);
  assert.equal(bucket.take(), null);
  assert.equal(bucket.take(), null);
  assert.equal(bucket.take(), 1_000);
});

test('a backwards clock refills nothing', () => {
  const clock = makeClock();
  const bucket = new TokenBucket({ capacity: 1, refillIntervalMs: 1_000, now: clock.now });
  assert.equal(bucket.take(), null);
  clock.advance(-10_000);
  assert.equal(bucket.take(), 1_000);
});

test('host enrollment has one process-global budget across concurrent callers', async () => {
  const clock = makeClock();
  const { app } = await freshApp({ now: clock.now, credentialFailureDelayMs: 1 });
  const responses = await Promise.all(
    Array.from({ length: HOST_ENROLL_ATTEMPT_BURST + 3 }, () =>
      post(app, API_ROUTES.hostEnroll, { password: 'wrong' }),
    ),
  );

  assert.equal(responses.filter((res) => res.status === 401).length, HOST_ENROLL_ATTEMPT_BURST);
  assert.equal(responses.filter((res) => res.status === 429).length, 3);
  assert.equal(responses.at(-1).headers.get('retry-after'), '1');

  clock.advance(HOST_ENROLL_ATTEMPT_REFILL_MS - 1);
  assert.equal((await post(app, API_ROUTES.hostEnroll, {})).status, 429);
  clock.advance(1);
  assert.equal((await post(app, API_ROUTES.hostEnroll, {})).status, 400);
});

test('oversized enrollment bodies spend admission before they are read', async () => {
  const { app } = await freshApp();
  const oversized = JSON.stringify({ pad: 'A'.repeat(MAX_REQUEST_BODY_BYTES + 1) });
  const send = () =>
    app.request(API_ROUTES.hostEnroll, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    });

  for (let i = 0; i < HOST_ENROLL_ATTEMPT_BURST; i += 1) {
    assert.equal((await send()).status, 413);
  }
  assert.equal((await send()).status, 429);

  // A preflight is not a credential attempt and spends nothing.
  const fresh = await freshApp();
  assert.equal(
    (
      await fresh.app.request(API_ROUTES.hostEnroll, {
        method: 'OPTIONS',
        headers: { origin: 'https://example.test', 'access-control-request-method': 'POST' },
      })
    ).status,
    204,
  );
  assert.equal((await post(fresh.app, API_ROUTES.hostEnroll, {})).status, 400);
});
