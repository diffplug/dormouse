import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  E2E_ID_LENGTH,
  MAX_E2E_CIPHERTEXT_LENGTH,
  MAX_E2E_CLIENT_ID_LENGTH,
  MAX_TERMINAL_DIMENSION,
  NOISE_MAX_MESSAGE_LENGTH,
  clampTerminalDimension,
  isE2eCiphertext,
  isE2eClientFrame,
  isE2eHostFrame,
  isE2eId,
  isE2eServerToHostFrame,
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

// --- The `e2e` relay envelope ---------------------------------------------

const E2E_CLIENT = {
  t: 'e2e',
  hostId: 'AAAAAAAAAAAAAAAAAAAAAA',
  kind: 'connection',
  id: 'BBBBBBBBBBBBBBBBBBBBBB',
  step: 'init',
  ct: 'Zm9v',
};
const E2E_HOST = {
  t: 'e2e',
  clientId: 'c-1',
  kind: 'pairing',
  id: E2E_CLIENT.id,
  step: 'response',
  ct: 'Zm9v',
};

test('the ciphertext bound is the base64url encoding of a maximal Noise message', () => {
  // 65535 is divisible by 3, so the encoding is exactly 4/3 of it and unpadded.
  assert.equal(MAX_E2E_CIPHERTEXT_LENGTH, (NOISE_MAX_MESSAGE_LENGTH / 3) * 4);
  assert.equal(isE2eCiphertext('a'.repeat(MAX_E2E_CIPHERTEXT_LENGTH)), true);
  assert.equal(isE2eCiphertext('a'.repeat(MAX_E2E_CIPHERTEXT_LENGTH + 1)), false);
  assert.equal(isE2eCiphertext(''), false);
  assert.equal(isE2eCiphertext('not/base64url+'), false);
  assert.equal(isE2eCiphertext(42), false);
});

test('every routing id is base64url of exactly 16 bytes', () => {
  assert.equal(E2E_ID_LENGTH, 22);
  assert.equal(isE2eId('B'.repeat(22)), true);
  assert.equal(isE2eId('B'.repeat(21)), false);
  assert.equal(isE2eId('B'.repeat(23)), false);
  assert.equal(isE2eId('B'.repeat(21) + '/'), false);
});

test('isE2eClientFrame accepts a real frame and refuses every malformed one', () => {
  assert.equal(isE2eClientFrame(E2E_CLIENT), true);
  assert.equal(isE2eClientFrame({ ...E2E_CLIENT, step: 'transport' }), true);
  assert.equal(isE2eClientFrame({ ...E2E_CLIENT, kind: 'pairing' }), true);
  for (const frame of [
    null,
    'nope',
    { ...E2E_CLIENT, t: 'msg' },
    { ...E2E_CLIENT, hostId: 'short' },
    { ...E2E_CLIENT, kind: 'terminal' },
    { ...E2E_CLIENT, id: 'short' },
    // `response` is the Host's step; a Client claiming it is not this frame.
    { ...E2E_CLIENT, step: 'response' },
    { ...E2E_CLIENT, step: 'init2' },
    { ...E2E_CLIENT, ct: 'a'.repeat(MAX_E2E_CIPHERTEXT_LENGTH + 1) },
    { ...E2E_CLIENT, ct: '' },
  ]) {
    assert.equal(isE2eClientFrame(frame), false, JSON.stringify(frame));
  }
});

test('isE2eServerToHostFrame additionally proves the relay-stamped clientId', () => {
  assert.equal(isE2eServerToHostFrame(E2E_CLIENT), false, 'no clientId');
  assert.equal(isE2eServerToHostFrame({ ...E2E_CLIENT, clientId: 'c-1' }), true);
  assert.equal(
    isE2eServerToHostFrame({ ...E2E_CLIENT, clientId: 'c'.repeat(MAX_E2E_CLIENT_ID_LENGTH + 1) }),
    false,
    'the id is a map key on a path the model does not trust',
  );
});

test('isE2eHostFrame takes the host steps and no hostId', () => {
  assert.equal(isE2eHostFrame(E2E_HOST), true);
  assert.equal(isE2eHostFrame({ ...E2E_HOST, step: 'transport' }), true);
  for (const frame of [
    { ...E2E_HOST, step: 'init' },
    { ...E2E_HOST, clientId: 42 },
    { ...E2E_HOST, kind: 'nope' },
    { ...E2E_HOST, id: 'short' },
    { ...E2E_HOST, ct: 'has spaces' },
  ]) {
    assert.equal(isE2eHostFrame(frame), false, JSON.stringify(frame));
  }
});
