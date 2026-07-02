import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ecdsaDerToRaw, ecdsaRawToDer } from '../dist/index.js';

test('raw→DER→raw round-trips random signatures', () => {
  for (let i = 0; i < 50; i++) {
    const raw = globalThis.crypto.getRandomValues(new Uint8Array(64));
    assert.deepEqual(ecdsaDerToRaw(ecdsaRawToDer(raw)), raw);
  }
});

test('round-trips coordinates with leading zeros', () => {
  const raw = new Uint8Array(64);
  raw[5] = 0x01; // r has five leading zero bytes
  raw[63] = 0x02; // s is tiny
  assert.deepEqual(ecdsaDerToRaw(ecdsaRawToDer(raw)), raw);
});

test('round-trips coordinates with the high bit set (DER sign padding)', () => {
  const raw = new Uint8Array(64).fill(0xff);
  const der = ecdsaRawToDer(raw);
  // Each 32-byte 0xff… integer needs a 0x00 sign pad: 2 + (2+33)*2 bytes.
  assert.equal(der.length, 72);
  assert.deepEqual(ecdsaDerToRaw(der), raw);
});

test('encodes a known small signature', () => {
  const raw = new Uint8Array(64);
  raw[31] = 0x01;
  raw[63] = 0x02;
  assert.deepEqual(ecdsaRawToDer(raw), Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02));
});

test('DER parsing rejects malformed input', () => {
  assert.throws(() => ecdsaDerToRaw(new Uint8Array(0)), /SEQUENCE/);
  assert.throws(() => ecdsaDerToRaw(Uint8Array.of(0x31, 0x00)), /SEQUENCE/);
  assert.throws(() => ecdsaDerToRaw(Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01)), /length mismatch/);
  assert.throws(() => ecdsaDerToRaw(Uint8Array.of(0x30, 0x04, 0x03, 0x01, 0x01, 0x02)), /INTEGER/);
  const valid = ecdsaRawToDer(globalThis.crypto.getRandomValues(new Uint8Array(64)));
  const trailing = new Uint8Array(valid.length + 1);
  trailing.set(valid);
  assert.throws(() => ecdsaDerToRaw(trailing), /invalid DER/);
});

test('DER parsing rejects integers wider than the curve', () => {
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(64));
  const der = ecdsaRawToDer(raw);
  assert.throws(() => ecdsaDerToRaw(der, 16), /too large/);
});

test('raw encoding rejects odd lengths', () => {
  assert.throws(() => ecdsaRawToDer(new Uint8Array(63)), /length/);
  assert.throws(() => ecdsaRawToDer(new Uint8Array(0)), /length/);
});

test('interoperates with WebCrypto ECDSA signatures', async () => {
  const { privateKey, publicKey } = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const data = globalThis.crypto.getRandomValues(new Uint8Array(100));
  const raw = new Uint8Array(
    await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data),
  );
  const roundTripped = ecdsaDerToRaw(ecdsaRawToDer(raw));
  assert.equal(
    await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      roundTripped,
      data,
    ),
    true,
  );
});
