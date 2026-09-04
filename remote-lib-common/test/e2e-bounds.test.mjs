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

test('the idle timeout leaves room for four missed keepalives', () => {
  assert.equal(ESTABLISHED_E2E_IDLE_TIMEOUT_MS / E2E_KEEPALIVE_INTERVAL_MS, 4);
});

test('the crypto burst matches the number of handshakes that may be pending', () => {
  assert.equal(E2E_INIT_BURST, MAX_PENDING_PAIRINGS);
});

test('the established-session cap sits above the pending caps', () => {
  assert.ok(MAX_ESTABLISHED_E2E_SESSIONS > MAX_PENDING_PAIRINGS);
});

// The three numbers the spec names in prose, so a bound cannot move without the
// text that documents it (`docs/specs/remote-security-model.md` -> Host bounds).
test('the values the spec names are the values that ship', () => {
  assert.equal(MAX_ESTABLISHED_E2E_SESSIONS, 16);
  assert.equal(E2E_KEEPALIVE_INTERVAL_MS, 30_000);
  assert.equal(ESTABLISHED_E2E_IDLE_TIMEOUT_MS, 120_000);
  assert.equal(E2E_INIT_REFILL_INTERVAL_MS, 1_000);
});
