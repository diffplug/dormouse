import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ENROLL_OFFER_MAX_AGE_MS,
  isEnrollmentOffer,
  isEnrollmentOfferFresh,
} from '../dist/index.js';

const TOKEN = 'a1b2c3d4'.repeat(8);

const OFFER = {
  origin: 'https://dormouse.tailnet.ts.net',
  token: TOKEN,
  mintedAt: '2026-08-31T12:00:00.000Z',
};

test('a well-formed offer passes, extra fields and all', () => {
  assert.equal(isEnrollmentOffer(OFFER), true);
  assert.equal(isEnrollmentOffer({ ...OFFER, note: 'written by install-macos.sh' }), true);
  assert.equal(isEnrollmentOffer({ ...OFFER, origin: 'http://localhost:3000' }), true);
});

test('non-objects are not offers', () => {
  for (const value of [null, undefined, 'offer', 42, []]) {
    assert.equal(isEnrollmentOffer(value), false);
  }
});

test('origin must be an origin, not a URL with anything after it', () => {
  for (const origin of [
    'https://dormouse.tailnet.ts.net/',
    'https://dormouse.tailnet.ts.net/enroll',
    'https://dormouse.tailnet.ts.net?x=1',
    'dormouse.tailnet.ts.net',
    'not a url',
    '',
  ]) {
    assert.equal(isEnrollmentOffer({ ...OFFER, origin }), false, origin);
  }
});

test('token must be exactly 64 lowercase hex characters', () => {
  for (const token of [
    TOKEN.slice(0, 32),
    `${TOKEN}0`,
    TOKEN.toUpperCase(),
    TOKEN.replace('a', 'g'),
    '',
  ]) {
    assert.equal(isEnrollmentOffer({ ...OFFER, token }), false, token);
  }
});

test('mintedAt is a bounded, non-empty string', () => {
  assert.equal(isEnrollmentOffer({ ...OFFER, mintedAt: '' }), false);
  assert.equal(isEnrollmentOffer({ ...OFFER, mintedAt: 'x'.repeat(64) }), true);
  assert.equal(isEnrollmentOffer({ ...OFFER, mintedAt: 'x'.repeat(65) }), false);
});

test('freshness lasts exactly 24 hours and tolerates a future stamp', () => {
  const minted = Date.parse(OFFER.mintedAt);
  assert.equal(isEnrollmentOfferFresh(OFFER, minted + ENROLL_OFFER_MAX_AGE_MS), true);
  assert.equal(isEnrollmentOfferFresh(OFFER, minted + ENROLL_OFFER_MAX_AGE_MS + 1), false);
  assert.equal(isEnrollmentOfferFresh(OFFER, minted - 1), true);
  assert.equal(isEnrollmentOfferFresh({ ...OFFER, mintedAt: 'last Tuesday' }, minted), false);
});

test('every field is required, and none may be mistyped', () => {
  for (const key of ['origin', 'token', 'mintedAt']) {
    const missing = { ...OFFER };
    delete missing[key];
    assert.equal(isEnrollmentOffer(missing), false, key);
    assert.equal(isEnrollmentOffer({ ...OFFER, [key]: 7 }), false, key);
  }
});
