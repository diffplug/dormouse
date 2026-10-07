/**
 * The shared end-to-end session bounds
 * (docs/specs/remote-security-model.md -> Burrow bounds). What the Burrow does with
 * them is `lib/src/remote/burrow/burrow-bounds.test.ts`; what this file
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
  PRESENCE_WINDOW_IDLE_MS,
  PRESENCE_WINDOW_MAX_MS,
  RELAY_SESSION_TTL_MS,
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

test('a presence window outlives the idle reap of the session that ran under it', () => {
  // A phone backgrounded past the established-session reap comes back inside
  // its window, which is the whole point of having one.
  assert.ok(PRESENCE_WINDOW_IDLE_MS > ESTABLISHED_E2E_IDLE_TIMEOUT_MS);
});

test('a presence window lives no longer than the relay session that reaches the Burrow', () => {
  assert.ok(PRESENCE_WINDOW_MAX_MS <= RELAY_SESSION_TTL_MS);
});

// The three numbers the spec names in prose, so a bound cannot move without the
// text that documents it (`docs/specs/remote-security-model.md` -> Burrow bounds).
test('the values the spec names are the values that ship', () => {
  assert.equal(MAX_ESTABLISHED_E2E_SESSIONS, 16);
  assert.equal(E2E_KEEPALIVE_INTERVAL_MS, 30_000);
  assert.equal(ESTABLISHED_E2E_IDLE_TIMEOUT_MS, 120_000);
  assert.equal(E2E_INIT_REFILL_INTERVAL_MS, 1_000);
  assert.equal(PRESENCE_WINDOW_IDLE_MS, 300_000);
  assert.equal(PRESENCE_WINDOW_MAX_MS, 12 * 60 * 60 * 1000);
});
