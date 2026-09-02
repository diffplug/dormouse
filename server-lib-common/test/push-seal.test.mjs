/**
 * The sealed push envelope (docs/specs/remote-security-model.md -> Push
 * sealing).
 *
 * A push is the one message with no live Noise session behind it, so what
 * matters here is that the construction is a *separate* one: a fresh key per
 * message from a random salt, the all-zero nonce spent exactly once under it,
 * and no `CipherState` anywhere near it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  MAX_SEALED_PUSH_LENGTH,
  MAX_SEALED_PUSH_PLAINTEXT_LENGTH,
  PUSH_SEAL_DOMAIN,
  PUSH_SEAL_SALT_LENGTH,
  fromBase64Url,
  generateNoiseKeyPair,
  isSealedPushV1,
  openPush,
  sealPush,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from '../dist/index.js';

const PLAINTEXT = utf8Encode(JSON.stringify({ title: 'build finished', body: 'zsh', tag: 'pty-1' }));

/** A Host and two Clients, the shape every case below needs. */
async function parties() {
  const host = await generateNoiseKeyPair();
  const client = await generateNoiseKeyPair();
  const other = await generateNoiseKeyPair();
  return { host, client, other };
}

function seal(host, client, plaintext = PLAINTEXT) {
  return sealPush({
    hostStaticPrivateKey: host.privateKey,
    clientStaticPublicKey: client.publicKey,
    plaintext,
  });
}

function open(client, host, sealed) {
  return openPush({
    clientStaticPrivateKey: client.privateKey,
    hostStaticPublicKey: host.publicKey,
    sealed,
  });
}

test('a sealed push round-trips between the paired statics', async () => {
  const { host, client } = await parties();

  const sealed = await seal(host, client);
  assert.equal(sealed.v, 1);
  assert.ok(isSealedPushV1(sealed));
  assert.equal(fromBase64Url(sealed.salt).length, PUSH_SEAL_SALT_LENGTH);

  const opened = await open(client, host, sealed);
  assert.deepEqual(utf8Decode(opened), utf8Decode(PLAINTEXT));
});

test('every message gets its own salt, and so its own key and ciphertext', async () => {
  const { host, client } = await parties();

  const first = await seal(host, client);
  const second = await seal(host, client);

  // Same plaintext, same statics: only the salt makes these differ, which is
  // what lets one fixed nonce be safe.
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.ct, second.ct);
  assert.deepEqual(utf8Decode(await open(client, host, first)), utf8Decode(PLAINTEXT));
  assert.deepEqual(utf8Decode(await open(client, host, second)), utf8Decode(PLAINTEXT));
});

// The all-zero nonce is spent once per key *by construction*: a key exists only
// for the salt it was derived from, and there is no counter to advance. Moving
// a ciphertext under a second salt is the observable form of reusing that
// nonce under a different key, and it must not open.
test('a ciphertext is bound to the salt its key came from', async () => {
  const { host, client } = await parties();

  const first = await seal(host, client);
  const second = await seal(host, client);

  assert.equal(await open(client, host, { v: 1, salt: second.salt, ct: first.ct }), null);
  assert.equal(await open(client, host, { v: 1, salt: first.salt, ct: second.ct }), null);
});

test('any tampered byte opens as null rather than as plaintext', async () => {
  const { host, client } = await parties();
  const sealed = await seal(host, client);

  for (const field of ['ct', 'salt']) {
    const bytes = fromBase64Url(sealed[field]);
    for (let i = 0; i < bytes.length; i++) {
      const flipped = Uint8Array.from(bytes);
      flipped[i] ^= 0x01;
      const attempt = { ...sealed, [field]: toBase64Url(flipped) };
      assert.equal(await open(client, host, attempt), null, `${field}[${i}]`);
    }
  }
});

test('the wrong Client key opens nothing', async () => {
  const { host, client, other } = await parties();
  const sealed = await seal(host, client);

  assert.equal(await open(other, host, sealed), null);
});

test('the wrong Host key opens nothing', async () => {
  const { host, client, other } = await parties();
  const sealed = await seal(host, client);

  // The pin is what authenticates the sender: a Server that swapped the Host
  // static a phone believes in still cannot produce a readable push.
  assert.equal(await open(client, other, sealed), null);
});

test('an all-zero shared secret is a failure, never a key', async () => {
  const { host, client } = await parties();
  // A low-order point: X25519 with it agrees to all zeroes, which every other
  // peer can compute too. Node rejects it outright; either way nothing seals.
  const lowOrder = new Uint8Array(32);

  await assert.rejects(
    () =>
      sealPush({
        hostStaticPrivateKey: host.privateKey,
        clientStaticPublicKey: lowOrder,
        plaintext: PLAINTEXT,
      }),
  );
  assert.equal(
    await openPush({
      clientStaticPrivateKey: client.privateKey,
      hostStaticPublicKey: lowOrder,
      sealed: await seal(host, client),
    }),
    null,
  );
});

test('the guard refuses a malformed or unbounded envelope before any crypto runs', async () => {
  const { host, client } = await parties();
  const sealed = await seal(host, client);

  for (const bad of [
    null,
    'not an object',
    { ...sealed, v: 2 },
    { ...sealed, salt: sealed.salt.slice(0, -1) },
    { ...sealed, salt: `${sealed.salt}A` },
    { ...sealed, ct: '' },
    { ...sealed, ct: 'A'.repeat(MAX_SEALED_PUSH_LENGTH + 1) },
    { ...sealed, ct: 'A'.repeat(4) },
    { ...sealed, ct: `${sealed.ct}=` },
    { v: 1, salt: sealed.salt },
  ]) {
    assert.equal(isSealedPushV1(bad), false, JSON.stringify(bad));
    assert.equal(await open(client, host, bad), null);
  }
});

test('a maximal plaintext seals inside the bound, and one byte more does not', async () => {
  const { host, client } = await parties();

  const maximal = await seal(host, client, new Uint8Array(MAX_SEALED_PUSH_PLAINTEXT_LENGTH));
  assert.ok(isSealedPushV1(maximal));
  assert.ok(maximal.ct.length <= MAX_SEALED_PUSH_LENGTH);
  // The whole envelope, as the Server forwards it, stays far inside the ~4 KB
  // every push service allows.
  const wire = JSON.stringify({ hostId: toBase64Url(new Uint8Array(16)), ...maximal });
  assert.ok(wire.length < 4096, `envelope is ${wire.length} bytes`);

  await assert.rejects(
    () => seal(host, client, new Uint8Array(MAX_SEALED_PUSH_PLAINTEXT_LENGTH + 1)),
    /too long/,
  );
});

// The construction is domain-separated and standalone. Importing Noise's
// transport would be the one way to reintroduce a shared `CipherState`, so the
// prohibition is checked against the source rather than trusted to review.
test('the seal shares no state with the Noise transport', async () => {
  const source = await readFile(new URL('../src/security/push-seal.ts', import.meta.url), 'utf8');

  assert.equal(source.includes('noise-transport'), false);
  assert.equal(source.includes('NoiseCipherState'), false);
  assert.equal(PUSH_SEAL_DOMAIN, 'dormouse/push/v1');
});
