import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../dist/app.js';
import { PASSWORD, freshApp } from './helpers.mjs';

/**
 * `createApp` compares `config.origin` as a string — the WebAuthn
 * `clientData.origin` check and the enrollment `origin` a Burrow composes its QR
 * from — so anything but a bare origin fails every one of them
 * while reading as correct. `readConfig` normalizes for the entrypoint; this is
 * the boundary refusing to be handed one that was not.
 */
test('createApp refuses an origin that is not already bare, or not http(s)', () => {
  for (const origin of [
    'https://dor.example.ts.net/',
    'https://dor.example.ts.net/pocket',
    'https://Dor.Example.TS.NET',
    'dor.example.ts.net',
    // `isOrigin` alone admits every WHATWG special scheme, and everything
    // downstream reads this as http(s): no browser sends one as
    // `clientData.origin`, and the Pocket CSP derives its WebSocket source by
    // slicing `http` off the front.
    'ws://dor.example.ts.net',
    'wss://dor.example.ts.net',
    'ftp://dor.example.ts.net',
  ]) {
    assert.throws(
      () => createApp({ setupPassword: PASSWORD, origin, stateDir: '/nonexistent' }),
      /bare http\(s\) origin/,
      origin,
    );
  }
});

test('createApp refuses a setup password outside the canonical 32-byte hex shape', () => {
  for (const setupPassword of ['word', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) {
    assert.throws(
      () => createApp({ setupPassword, origin: 'http://localhost:3000', stateDir: '/nonexistent' }),
      /64 lowercase hexadecimal characters/,
      setupPassword,
    );
  }
});

test('GET / serves the stub landing page when the Pocket app is not built', async () => {
  // freshApp configures no `pocketDir`, so this is always the stub (slice 5
  // serves the real Pocket build here when `pocketDir` points at one).
  const { app } = await freshApp();
  const res = await app.request('/');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /^Dormouse selfhost Relay/);
  assert.match(body, /build:pocket/);
});

test('GET /api/hello returns the fixed health response', async () => {
  const { app } = await freshApp();
  const res = await app.request('/api/hello');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { message: 'Hello, world!' });
});
