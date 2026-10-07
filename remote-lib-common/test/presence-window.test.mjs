/**
 * The Burrow's presence windows (docs/specs/remote-security-model.md ->
 * Presence window). What `BurrowRuntime` does with them is
 * `lib/src/remote/burrow/burrow-runtime.test.ts`; what this file pins is the
 * arithmetic of open and closed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PRESENCE_WINDOW_IDLE_MS, PRESENCE_WINDOW_MAX_MS, PresenceWindows } from '../dist/index.js';
import { makeClock } from './harness/clock.mjs';

const STATIC = 'client-static';
const RECORD = {
  accountId: 'ned@dormouse.dev',
  passkeyCredentialId: 'cred-1',
  passkeyPublicKeyHash: 'hash-1',
};

function seeded() {
  const clock = makeClock();
  const windows = new PresenceWindows({ now: clock.now });
  windows.seed(STATIC, RECORD, clock.now());
  return { clock, windows };
}

test('a seeded window is open for its static only, and names its identities', () => {
  const { clock, windows } = seeded();
  assert.deepEqual(windows.open(STATIC), { ...RECORD, provedAt: clock.now(), activeAt: clock.now() });
  assert.equal(windows.open('another-static'), null);
});

test('a window closes once idle, and stays closed', () => {
  const { clock, windows } = seeded();
  clock.advance(PRESENCE_WINDOW_IDLE_MS - 1);
  assert.notEqual(windows.open(STATIC), null);
  clock.advance(1);
  assert.equal(windows.open(STATIC), null);
  // Found closed, it is gone: later activity has nothing to extend.
  windows.noteActivity(STATIC, clock.now());
  assert.equal(windows.open(STATIC), null);
});

test('folded activity extends the idle bound, and never moves it back', () => {
  const { clock, windows } = seeded();
  clock.advance(PRESENCE_WINDOW_IDLE_MS - 1);
  windows.noteActivity(STATIC, clock.now());
  const activeAt = clock.now();
  clock.advance(PRESENCE_WINDOW_IDLE_MS - 1);
  windows.noteActivity(STATIC, activeAt - 1);
  assert.equal(windows.open(STATIC)?.activeAt, activeAt);
  clock.advance(1);
  assert.equal(windows.open(STATIC), null);
});

test('the cap closes a window however active it stays, and only a new proof reopens it', () => {
  const { clock, windows } = seeded();
  clock.advance(PRESENCE_WINDOW_MAX_MS - 1);
  windows.noteActivity(STATIC, clock.now());
  assert.notEqual(windows.open(STATIC), null);
  clock.advance(1);
  windows.noteActivity(STATIC, clock.now());
  assert.equal(windows.open(STATIC), null);
  windows.seed(STATIC, RECORD, clock.now());
  assert.equal(windows.open(STATIC)?.provedAt, clock.now());
});

test('seeding replaces the entry and sweeps every capped one', () => {
  const { clock, windows } = seeded();
  windows.seed('other-static', RECORD, clock.now() + 1);
  clock.advance(PRESENCE_WINDOW_MAX_MS);
  const repaired = { ...RECORD, passkeyCredentialId: 'cred-2' };
  windows.seed('third-static', repaired, clock.now());
  // The first one reached its cap and went; the second is one millisecond short.
  assert.equal(windows.size, 2);
  windows.seed('other-static', repaired, clock.now());
  assert.equal(windows.open('other-static')?.passkeyCredentialId, repaired.passkeyCredentialId);
});

test('clear closes every window outright', () => {
  const { windows } = seeded();
  windows.seed('other-static', RECORD, 1_700_000_000_000);
  windows.clear();
  assert.equal(windows.open(STATIC), null);
  assert.equal(windows.open('other-static'), null);
});
