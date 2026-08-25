import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CHALLENGE_TTL_MS, HostChallengeIssuer, fromBase64Url } from '../dist/index.js';
import { FakeClock } from './harness/actors.mjs';

test('issued challenges are 32 bytes and unique', () => {
  const issuer = new HostChallengeIssuer();
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const { challenge } = issuer.issue();
    assert.equal(fromBase64Url(challenge).length, 32);
    seen.add(challenge);
  }
  assert.equal(seen.size, 100);
});

test('issue stamps issuedAt and expiresAt from the clock and ttl', () => {
  const clock = new FakeClock();
  const issuer = new HostChallengeIssuer({ now: clock.now, ttlMs: 5000 });
  const issued = issuer.issue();
  assert.equal(issued.issuedAt, clock.now());
  assert.equal(issued.expiresAt, clock.now() + 5000);
});

test('a fresh challenge consumes exactly once', () => {
  const clock = new FakeClock();
  const issuer = new HostChallengeIssuer({ now: clock.now });
  const { challenge } = issuer.issue();
  assert.equal(issuer.consume(challenge), true);
  assert.equal(issuer.consume(challenge), false, 'second consume must fail');
});

test('an expired challenge cannot be consumed', () => {
  const clock = new FakeClock();
  const issuer = new HostChallengeIssuer({ now: clock.now, ttlMs: 1000 });
  const { challenge } = issuer.issue();
  clock.advance(1000);
  assert.equal(issuer.consume(challenge), false);
  clock.advance(-500); // even if the clock rewinds, consumption already burned it
  assert.equal(issuer.consume(challenge), false);
});

test('a challenge consumed just before expiry succeeds', () => {
  const clock = new FakeClock();
  const issuer = new HostChallengeIssuer({ now: clock.now, ttlMs: 1000 });
  const { challenge } = issuer.issue();
  clock.advance(999);
  assert.equal(issuer.consume(challenge), true);
});

test('unknown challenges are rejected', () => {
  const issuer = new HostChallengeIssuer();
  assert.equal(issuer.consume('bm90LWEtY2hhbGxlbmdl'), false);
  assert.equal(issuer.consume(''), false);
});

test('challenges from one issuer are unknown to another', () => {
  const a = new HostChallengeIssuer();
  const b = new HostChallengeIssuer();
  const { challenge } = a.issue();
  assert.equal(b.consume(challenge), false);
  assert.equal(a.consume(challenge), true);
});

test('the default ttl is two minutes', () => {
  assert.equal(DEFAULT_CHALLENGE_TTL_MS, 120_000);
});

// Regression: nothing ever reclaimed challenges that were minted and never
// redeemed, so they accumulated for the life of the process. `POST
// /api/signin/begin` mints one per request with no authentication in front of
// it, which made that an unauthenticated memory-growth vector.
test('issuing reclaims abandoned challenges instead of accumulating them', () => {
  const clock = new FakeClock();
  const issuer = new HostChallengeIssuer({ now: clock.now, ttlMs: 1000 });
  for (let i = 0; i < 50; i++) issuer.issue(); // minted, never consumed
  assert.equal(issuer.pendingCount, 50);
  clock.advance(1000);
  const fresh = issuer.issue();
  assert.equal(issuer.pendingCount, 1, 'the abandoned challenges must not survive');
  assert.equal(issuer.consume(fresh.challenge), true);
});

test('issuing never reclaims a challenge that is still live', () => {
  const clock = new FakeClock();
  const issuer = new HostChallengeIssuer({ now: clock.now, ttlMs: 1000 });
  const stale = issuer.issue();
  clock.advance(600);
  const live = issuer.issue();
  clock.advance(500); // stale is past ttl; live still has 500ms
  issuer.issue();
  assert.equal(issuer.consume(stale.challenge), false);
  assert.equal(issuer.consume(live.challenge), true, 'a live challenge must survive the sweep');
});
