/**
 * What is left of `pairing.ts` after the E2E cutover: the label reducer both
 * ceremonies share. The Host's own ceremony is `e2e-ceremony.test.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { boundedPairingLabel } from '../dist/index.js';

test('boundedPairingLabel strips bidi and caps length', () => {
  const bounded = boundedPairingLabel(`‮owner${'A'.repeat(500)}`);
  assert.equal(bounded.includes('‮'), false);
  assert.ok(Array.from(bounded).length <= 64);
  assert.equal(boundedPairingLabel(undefined), '(unnamed)');
});
