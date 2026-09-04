/**
 * The shared token bucket. Its two consumers — the Host's crypto budget
 * (`lib/src/remote/host/remote-host.ts`) and the Server's Host-enrollment
 * admission (`server/src/app.ts`) — pin their own wiring; what this file pins
 * is the refill arithmetic both rely on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TokenBucket } from '../dist/index.js';
import { makeClock } from './harness/clock.mjs';

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

test('a bucket that would never refuse is refused at construction', () => {
  // `refillIntervalMs: 0` divides to Infinity: every call would refill the
  // bucket whole, and the bound two `FAIL IF` clauses rest on would be gone
  // while every call still returned `null` as though it were working.
  for (const options of [
    { capacity: 0, refillIntervalMs: 1_000 },
    { capacity: -1, refillIntervalMs: 1_000 },
    { capacity: 1.5, refillIntervalMs: 1_000 },
    { capacity: 8, refillIntervalMs: 0 },
    { capacity: 8, refillIntervalMs: -1 },
    { capacity: 8, refillIntervalMs: 1.5 },
  ]) {
    assert.throws(() => new TokenBucket(options), /positive safe integer/, JSON.stringify(options));
  }
});
