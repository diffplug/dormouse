/**
 * Burrow-enrollment admission: the wiring of the shared `TokenBucket`
 * (`remote-lib-common/test/token-bucket.test.mjs` pins its arithmetic) onto
 * the one route that accepts a bootstrap credential.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { API_ROUTES } from 'remote-lib-common';

import {
  BURROW_ENROLL_ATTEMPT_BURST,
  BURROW_ENROLL_ATTEMPT_REFILL_MS,
  MAX_REQUEST_BODY_BYTES,
} from '../dist/app.js';
import { freshApp, makeClock, post } from './helpers.mjs';

test('burrow enrollment has one process-global budget across concurrent callers', async () => {
  const clock = makeClock();
  const { app } = await freshApp({ now: clock.now });
  const responses = await Promise.all(
    Array.from({ length: BURROW_ENROLL_ATTEMPT_BURST + 3 }, () =>
      post(app, API_ROUTES.burrowEnroll, { password: 'wrong' }),
    ),
  );

  assert.equal(responses.filter((res) => res.status === 401).length, BURROW_ENROLL_ATTEMPT_BURST);
  assert.equal(responses.filter((res) => res.status === 429).length, 3);
  assert.equal(responses.at(-1).headers.get('retry-after'), '1');

  clock.advance(BURROW_ENROLL_ATTEMPT_REFILL_MS - 1);
  assert.equal((await post(app, API_ROUTES.burrowEnroll, {})).status, 429);
  clock.advance(1);
  assert.equal((await post(app, API_ROUTES.burrowEnroll, {})).status, 400);
});

test('oversized enrollment bodies spend admission before they are read', async () => {
  // Frozen, like the case above: nine requests have to land inside one refill
  // interval or the last is a 413, and a wall-clock margin on a shared runner
  // would read as a regression in the ordering this exists to pin.
  const clock = makeClock();
  const { app } = await freshApp({ now: clock.now });
  const send = () =>
    post(app, API_ROUTES.burrowEnroll, { pad: 'A'.repeat(MAX_REQUEST_BODY_BYTES + 1) });

  for (let i = 0; i < BURROW_ENROLL_ATTEMPT_BURST; i += 1) {
    assert.equal((await send()).status, 413);
  }
  assert.equal((await send()).status, 429);

  // An OPTIONS probe is not a credential attempt and spends nothing.
  const fresh = await freshApp({ now: clock.now });
  assert.equal(
    (
      await fresh.app.request(API_ROUTES.burrowEnroll, {
        method: 'OPTIONS',
        headers: { origin: 'https://example.test', 'access-control-request-method': 'POST' },
      })
    ).status,
    404,
  );
  assert.equal((await post(fresh.app, API_ROUTES.burrowEnroll, {})).status, 400);
});
