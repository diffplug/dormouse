/**
 * The Burrow's presence windows (docs/specs/remote-security-model.md ->
 * Presence window). What `BurrowRuntime` does with them is
 * `lib/src/remote/burrow/burrow-runtime.test.ts`; what this file pins is the
 * arithmetic of open and closed, and that activity counts only toward the
 * record it was authorized under.
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
  approvedAt: 1_000,
};

function seeded() {
  const clock = makeClock();
  const windows = new PresenceWindows({ now: clock.now });
  windows.seed(STATIC, RECORD, clock.now());
  return { clock, windows };
}

test('a seeded window is open for its static only, and names its record', () => {
  const { clock, windows } = seeded();
  assert.deepEqual(windows.open(STATIC), { ...RECORD, provedAt: clock.now(), activeAt: clock.now() });
  assert.equal(windows.open('another-static'), null);
});

test('a window closes once idle, and is dropped when found closed', () => {
  const { clock, windows } = seeded();
  clock.advance(PRESENCE_WINDOW_IDLE_MS - 1);
  assert.notEqual(windows.open(STATIC), null);
  clock.advance(1);
  assert.equal(windows.open(STATIC), null);
  assert.equal(windows.size, 0);
});

test('folded activity extends the idle bound, but only under the same record', () => {
  const { clock, windows } = seeded();
  const under = (approvedAt, at = clock.now()) => windows.noteActivity(STATIC, { approvedAt, at });
  clock.advance(PRESENCE_WINDOW_IDLE_MS - 1);
  under(RECORD.approvedAt);
  const activeAt = clock.now();
  clock.advance(PRESENCE_WINDOW_IDLE_MS - 1);
  assert.equal(windows.open(STATIC)?.activeAt, activeAt);
  // Activity older than what is held never moves it back, and a session
  // authorized under an older record of this static extends nothing.
  under(RECORD.approvedAt, activeAt - 1);
  under(RECORD.approvedAt - 1);
  assert.equal(windows.open(STATIC)?.activeAt, activeAt);
  clock.advance(1);
  assert.equal(windows.open(STATIC), null);
});

test('live activity holds a window open without being folded in', () => {
  const { clock, windows } = seeded();
  clock.advance(PRESENCE_WINDOW_IDLE_MS);
  const live = { approvedAt: RECORD.approvedAt, at: clock.now() - 1 };
  assert.notEqual(windows.open(STATIC, live), null);
  // Under another record it counts for nothing, and the closed window goes.
  assert.equal(windows.open(STATIC, { ...live, approvedAt: RECORD.approvedAt + 1 }), null);
  assert.equal(windows.open(STATIC, live), null);
});

test('the cap closes a window however active it stays, and only a new proof reopens it', () => {
  const { clock, windows } = seeded();
  const active = () => ({ approvedAt: RECORD.approvedAt, at: clock.now() });
  clock.advance(PRESENCE_WINDOW_MAX_MS - 1);
  assert.notEqual(windows.open(STATIC, active()), null);
  clock.advance(1);
  assert.equal(windows.open(STATIC, active()), null);
  windows.seed(STATIC, RECORD, clock.now());
  assert.equal(windows.open(STATIC)?.provedAt, clock.now());
});

test('seeding replaces the entry and sweeps every capped one', () => {
  const { clock, windows } = seeded();
  windows.seed('other-static', RECORD, clock.now() + 1);
  clock.advance(PRESENCE_WINDOW_MAX_MS);
  const repaired = { ...RECORD, approvedAt: RECORD.approvedAt + 1 };
  windows.seed('third-static', repaired, clock.now());
  // The first one reached its cap and went; the second is one millisecond short.
  assert.equal(windows.size, 2);
  windows.seed('other-static', repaired, clock.now());
  assert.equal(windows.open('other-static')?.approvedAt, repaired.approvedAt);
});

test('forget and clear close windows outright', () => {
  const { windows } = seeded();
  windows.seed('other-static', RECORD, 1_700_000_000_000);
  windows.forget(STATIC);
  assert.equal(windows.open(STATIC), null);
  assert.notEqual(windows.open('other-static'), null);
  windows.clear();
  assert.equal(windows.size, 0);
});
