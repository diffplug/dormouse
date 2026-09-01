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

const MINT = { token: 'aZ0-_abc', mintId: 'mint-1', expiresAt: 1 };

test('isSetupTokenResponse accepts a real mint', () => {
  assert.equal(isSetupTokenResponse(MINT), true);
  // Additive fields are fine: an older Host reading a newer server still works.
  assert.equal(isSetupTokenResponse({ ...MINT, extra: true }), true);
  // A real token is base64url of 32 bytes, comfortably inside the bound.
  assert.equal(isSetupTokenResponse({ ...MINT, token: 'a'.repeat(128) }), true);
});

test('isSetupTokenResponse rejects a 200 that is not one', () => {
  // The Host puts the token straight into a QR encoder and `expiresAt` straight
  // into a `setTimeout` delay, so a missing, mistyped, oversized, or
  // out-of-charset field has to fail the exchange rather than reach either.
  for (const body of [
    null,
    'nope',
    {},
    { token: 'abc' },
    { expiresAt: 1 },
    { token: 'abc', mintId: 'm' },
    { ...MINT, token: '' },
    { ...MINT, token: 42 },
    // An oversized token throws inside the QR encoder, under the app-wide
    // ErrorBoundary, which takes every terminal down with it.
    { ...MINT, token: 'a'.repeat(129) },
    { ...MINT, token: 'has spaces' },
    { ...MINT, token: 'not/base64url+' },
    { ...MINT, mintId: '' },
    { ...MINT, mintId: 42 },
    { ...MINT, expiresAt: '1' },
    { ...MINT, expiresAt: Number.NaN },
    { ...MINT, expiresAt: Number.POSITIVE_INFINITY },
    // Epoch ms is always positive; zero or negative is a broken clock, and it
    // would make every refresh delay compute as "already expired".
    { ...MINT, expiresAt: 0 },
    { ...MINT, expiresAt: -1 },
  ]) {
    assert.equal(isSetupTokenResponse(body), false, JSON.stringify(body));
  }
});
