/**
 * The shared end-to-end session bounds
 * (docs/specs/remote-security-model.md -> Host bounds). What the Host does with
 * them is `lib/src/remote/host/remote-host-bounds.test.ts`; what this file
 * pins is the relationships between them, which is the part two endpoints
 * would otherwise disagree about.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  E2E_INIT_BURST,
  E2E_INIT_REFILL_INTERVAL_MS,
  E2E_KEEPALIVE_INTERVAL_MS,
  ESTABLISHED_E2E_IDLE_TIMEOUT_MS,
  MAX_ESTABLISHED_E2E_SESSIONS,
  MAX_PENDING_PAIRINGS,
} from '../dist/index.js';

test('the idle timeout leaves room for missed keepalives', () => {
  // A phone that loses one keepalive to a radio gap must not be reaped; one
  // suspended in the background must be. Four intervals is that line.
  assert.equal(ESTABLISHED_E2E_IDLE_TIMEOUT_MS / E2E_KEEPALIVE_INTERVAL_MS, 4);
});

test('the crypto burst matches the number of handshakes that may be pending', () => {
  // A burst larger than the pending caps buys nothing but WebCrypto work.
  assert.equal(E2E_INIT_BURST, MAX_PENDING_PAIRINGS);
  assert.equal(E2E_INIT_REFILL_INTERVAL_MS, 1_000);
});

test('the established-session cap is a number a laptop can actually serve', () => {
  assert.equal(MAX_ESTABLISHED_E2E_SESSIONS, 16);
  assert.ok(MAX_ESTABLISHED_E2E_SESSIONS > MAX_PENDING_PAIRINGS);
});
