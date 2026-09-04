/**
 * The shared token bucket. Its two consumers — the Host's crypto budget
 * (`lib/src/remote/host/remote-host.ts`) and the Server's Host-enrollment
 * admission (`server/src/app.ts`) — pin their own wiring; what this file pins
 * is the refill arithmetic both rely on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TokenBucket } from '../dist/index.js';

/** A manually-advanced clock, so refill is asserted rather than waited out. */
function makeClock(startMs = 1_700_000_000_000) {
  let ms = startMs;
  return { now: () => ms, advance: (delta) => (ms += delta) };
}

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
  // An idle hour does not mint an hour of tokens: the burst is the cap.
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
