import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_TERMINAL_DIMENSION,
  clampTerminalDimension,
  isSetupTokenResponse,
} from '../dist/index.js';

test('clampTerminalDimension falls back on absent or non-finite values', () => {
  assert.equal(clampTerminalDimension(undefined, 80), 80);
  assert.equal(clampTerminalDimension(Number.NaN, 24), 24);
  assert.equal(clampTerminalDimension(Number.POSITIVE_INFINITY, 24), 24);
});

test('clampTerminalDimension floors to a positive integer', () => {
  assert.equal(clampTerminalDimension(80.9, 24), 80);
  assert.equal(clampTerminalDimension(0, 24), 1);
  assert.equal(clampTerminalDimension(-5, 24), 1);
});

test('clampTerminalDimension bounds the top, not just the bottom', () => {
  // The security-relevant half: `terminal.resize` carries a peer-supplied
  // number to `term.resize` in the webview that owns the pane, and xterm
  // bounds only the minimum before allocating rows × cols cells. Unbounded,
  // one frame wedges every terminal in that window.
  assert.equal(clampTerminalDimension(1_000_000, 24), MAX_TERMINAL_DIMENSION);
  assert.equal(clampTerminalDimension(Number.MAX_SAFE_INTEGER, 24), MAX_TERMINAL_DIMENSION);
  assert.equal(clampTerminalDimension(MAX_TERMINAL_DIMENSION, 24), MAX_TERMINAL_DIMENSION);
  assert.equal(clampTerminalDimension(MAX_TERMINAL_DIMENSION + 1, 24), MAX_TERMINAL_DIMENSION);
  // A realistic large terminal is untouched.
  assert.equal(clampTerminalDimension(400, 24), 400);
});

test('isSetupTokenResponse accepts a real mint', () => {
  assert.equal(isSetupTokenResponse({ token: 'abc', expiresAt: 1 }), true);
  // Additive fields are fine: an older Host reading a newer server still works.
  assert.equal(isSetupTokenResponse({ token: 'abc', expiresAt: 1, extra: true }), true);
});

test('isSetupTokenResponse rejects a 200 that is not one', () => {
  // The Host puts the token straight into its QR and into the set that decides
  // `verified` on the next pairing, so a missing or mistyped field has to fail
  // the exchange rather than mint an `undefined`.
  for (const body of [
    null,
    'nope',
    {},
    { token: 'abc' },
    { expiresAt: 1 },
    { token: '', expiresAt: 1 },
    { token: 42, expiresAt: 1 },
    { token: 'abc', expiresAt: '1' },
    { token: 'abc', expiresAt: Number.NaN },
  ]) {
    assert.equal(isSetupTokenResponse(body), false, JSON.stringify(body));
  }
});
