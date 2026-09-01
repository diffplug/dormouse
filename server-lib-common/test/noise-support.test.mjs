/**
 * The X25519 capability probe
 * (docs/specs/remote-security-model.md -> E2E identities and presence).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { probeNoiseSupport } from '../dist/index.js';

test('a runtime with X25519 says yes', async () => {
  assert.equal(await probeNoiseSupport(), true);
});

test('a runtime that cannot generate an X25519 key says no rather than throwing', async () => {
  const crypto = {
    subtle: {
      generateKey: () => Promise.reject(new Error('NotSupportedError')),
      deriveBits: () => assert.fail('deriveBits must not run after generateKey rejected'),
    },
    getRandomValues: (array) => array,
  };
  assert.equal(await probeNoiseSupport(crypto), false);
});

test('a runtime whose agreement fails says no', async () => {
  const real = globalThis.crypto;
  const crypto = {
    subtle: {
      generateKey: (...args) => real.subtle.generateKey(...args),
      deriveBits: () => Promise.reject(new Error('OperationError')),
    },
    getRandomValues: (array) => real.getRandomValues(array),
  };
  assert.equal(await probeNoiseSupport(crypto), false);
});

test('a runtime with no WebCrypto at all says no', async () => {
  // `getWebCrypto` throws where `globalThis.crypto.subtle` is missing, and the
  // probe resolves the default inside its own guard so that is an answer too.
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
  try {
    assert.equal(await probeNoiseSupport(), false);
  } finally {
    Object.defineProperty(globalThis, 'crypto', saved);
  }
});
