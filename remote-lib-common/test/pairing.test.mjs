/**
 * What is left of `pairing.ts` after the E2E cutover: the Burrow's own label
 * bound. The ceremony, and the closed set a Client's label comes from, are
 * `e2e-ceremony.test.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { boundedBurrowLabel } from '../dist/index.js';

test('boundedBurrowLabel strips bidi and caps length', () => {
  const bounded = boundedBurrowLabel(`‮owner${'A'.repeat(500)}`);
  assert.equal(bounded.includes('‮'), false);
  assert.ok(Array.from(bounded).length <= 64);
  assert.equal(boundedBurrowLabel(undefined), '');
});
