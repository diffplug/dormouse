/**
 * The in-memory sign-in session store: swept as it mints, and bounded per
 * account and in all (`docs/specs/relay.md` -> Guardrails).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RELAY_SESSION_TTL_MS } from 'remote-lib-common';

import { MAX_SESSIONS, MAX_SESSIONS_PER_ACCOUNT, SessionStore } from '../dist/app.js';
import { makeClock } from './helpers.mjs';

test('a mint sweeps the sessions that have expired', () => {
  const clock = makeClock();
  const store = new SessionStore(clock.now);
  for (let i = 0; i < 5; i++) store.mint('acct');
  clock.advance(RELAY_SESSION_TTL_MS / 2);
  const { token: younger } = store.mint('acct');
  clock.advance(RELAY_SESSION_TTL_MS / 2);
  store.mint('acct');
  assert.equal(store.size, 2);
  assert.notEqual(store.validate(younger), null);
});

test("a sign-in past an account's bound ends that account's oldest session only", () => {
  const clock = makeClock();
  const store = new SessionStore(clock.now);
  const { token: other } = store.mint('other');
  const tokens = Array.from({ length: MAX_SESSIONS_PER_ACCOUNT }, () => {
    clock.advance(1);
    return store.mint('acct').token;
  });
  store.mint('acct');
  assert.equal(store.validate(tokens[0]), null);
  for (const token of tokens.slice(1)) assert.notEqual(store.validate(token), null);
  assert.notEqual(store.validate(other), null);
  assert.equal(store.size, MAX_SESSIONS_PER_ACCOUNT + 1);
});

test('the store holds at most its global bound, ending the oldest first', () => {
  const clock = makeClock();
  const store = new SessionStore(clock.now);
  const tokens = Array.from({ length: MAX_SESSIONS + 1 }, (_, i) => store.mint(`acct-${i}`).token);
  assert.equal(store.size, MAX_SESSIONS);
  assert.equal(store.validate(tokens[0]), null);
  assert.notEqual(store.validate(tokens[1]), null);
  assert.notEqual(store.validate(tokens.at(-1)), null);
});
