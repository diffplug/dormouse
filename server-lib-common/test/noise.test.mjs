/**
 * `Noise_IK_25519_ChaChaPoly_SHA256` (docs/specs/remote-security-model.md ->
 * Noise suite).
 *
 * Every expected value here comes from an independent source — the vendored
 * Cacophony vector, RFC 7748, RFC 8439 — never from our own state machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

import {
  NOISE_MAX_MESSAGE_LENGTH,
  NOISE_PROTOCOL_NAME,
  NoiseCipherState,
  NoiseError,
  concatBytes,
  createNoiseInitiator,
  createNoiseResponder,
  fromBase64Url,
  generateNoiseKeyPair,
  noiseNonceBytes,
} from '../dist/index.js';

const VECTOR = JSON.parse(
  readFileSync(new URL('./vectors/noise-ik-25519-chachapoly-sha256.json', import.meta.url), 'utf8'),
);

const EMPTY = new Uint8Array(0);

function unhex(text) {
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Vector private keys are raw 32-byte X25519 scalars; WebCrypto only imports
// PKCS#8, so wrap them in the fixed DER header for `id-X25519`.
const PKCS8_X25519_HEADER = unhex('302e020100300506032b656e04220420');

async function importScalar(scalarHex) {
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    concatBytes(PKCS8_X25519_HEADER, unhex(scalarHex)),
    { name: 'X25519' },
    true,
    ['deriveBits'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  return { privateKey, publicKey: fromBase64Url(jwk.x) };
}

/** The vector's four keypairs, imported once. */
const keys = {
  initStatic: await importScalar(VECTOR.init_static),
  initEphemeral: await importScalar(VECTOR.init_ephemeral),
  respStatic: await importScalar(VECTOR.resp_static),
  respEphemeral: await importScalar(VECTOR.resp_ephemeral),
};

function newInitiator(overrides = {}) {
  return createNoiseInitiator({
    prologue: unhex(VECTOR.init_prologue),
    staticKeyPair: keys.initStatic,
    remoteStaticPublicKey: unhex(VECTOR.init_remote_static),
    ephemeralKeyPair: keys.initEphemeral,
    ...overrides,
  });
}

function newResponder(overrides = {}) {
  return createNoiseResponder({
    prologue: unhex(VECTOR.resp_prologue),
    staticKeyPair: keys.respStatic,
    ephemeralKeyPair: keys.respEphemeral,
    ...overrides,
  });
}

/** Replay the vector's handshake and hand back both completed sides. */
async function completeHandshake() {
  const initiator = await newInitiator();
  const responder = await newResponder();
  await responder.readMessage(await initiator.writeMessage(unhex(VECTOR.messages[0].payload)));
  await initiator.readMessage(await responder.writeMessage(unhex(VECTOR.messages[1].payload)));
  return { initiator, responder };
}

test('the vendored vector is the suite this module implements', () => {
  assert.equal(VECTOR.protocol_name, NOISE_PROTOCOL_NAME);
  assert.equal(VECTOR.messages.length, 6);
});

test('both handshake messages match the Cacophony vector byte for byte', async () => {
  const initiator = await newInitiator();
  const responder = await newResponder();

  const message1 = await initiator.writeMessage(unhex(VECTOR.messages[0].payload));
  assert.equal(hex(message1), VECTOR.messages[0].ciphertext);

  const read1 = await responder.readMessage(unhex(VECTOR.messages[0].ciphertext));
  assert.equal(hex(read1), VECTOR.messages[0].payload);
  // IK authenticates the initiator's static key inside message 1.
  assert.equal(hex(responder.remoteStaticPublicKey), hex(keys.initStatic.publicKey));

  const message2 = await responder.writeMessage(unhex(VECTOR.messages[1].payload));
  assert.equal(hex(message2), VECTOR.messages[1].ciphertext);

  const read2 = await initiator.readMessage(unhex(VECTOR.messages[1].ciphertext));
  assert.equal(hex(read2), VECTOR.messages[1].payload);

  assert.equal(hex(initiator.session.handshakeHash), VECTOR.handshake_hash);
  assert.equal(hex(responder.session.handshakeHash), VECTOR.handshake_hash);
  assert.ok(initiator.isComplete && responder.isComplete);
});

test('every transport message matches the vector in both directions', async () => {
  const { initiator, responder } = await completeHandshake();
  for (let i = 2; i < VECTOR.messages.length; i++) {
    const fromInitiator = i % 2 === 0;
    const sender = fromInitiator ? initiator.session.send : responder.session.send;
    const receiver = fromInitiator ? responder.session.receive : initiator.session.receive;
    const { payload, ciphertext } = VECTOR.messages[i];

    assert.equal(hex(sender.encryptWithAd(EMPTY, unhex(payload))), ciphertext, `message ${i}`);
    assert.equal(hex(receiver.decryptWithAd(EMPTY, unhex(ciphertext))), payload, `message ${i}`);
  }
  assert.equal(initiator.session.send.nonce, 2n);
  assert.equal(responder.session.send.nonce, 2n);
});

test('the vector responder static really is the initiator remote static', async () => {
  // Guards the import path itself: a wrong PKCS#8 wrapping would silently
  // produce a different keypair and every later assertion would be circular.
  assert.equal(hex(keys.respStatic.publicKey), VECTOR.init_remote_static);
});

test('RFC 7748 section 6.1 X25519', async () => {
  const alice = await importScalar('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
  const bob = await importScalar('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
  assert.equal(hex(alice.publicKey), '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
  assert.equal(hex(bob.publicKey), 'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');

  const shared = '4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742';
  for (const [self, peer] of [
    [alice, bob],
    [bob, alice],
  ]) {
    const peerKey = await crypto.subtle.importKey('raw', peer.publicKey, { name: 'X25519' }, true, []);
    const bits = await crypto.subtle.deriveBits(
      { name: 'X25519', public: peerKey },
      self.privateKey,
      256,
    );
    assert.equal(hex(new Uint8Array(bits)), shared);
  }
});

test('RFC 8439 section 2.8.2 ChaCha20-Poly1305 through the bundled binding', () => {
  const key = unhex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
  const nonce = unhex('070000004041424344454647');
  const aad = unhex('50515253c0c1c2c3c4c5c6c7');
  const plaintext = unhex(
    '4c616469657320616e642047656e746c656d656e206f662074686520636c6173' +
      '73206f66202739393a204966204920636f756c64206f6666657220796f75206f' +
      '6e6c79206f6e652074697020666f7220746865206675747572652c2073756e73' +
      '637265656e20776f756c642062652069742e',
  );
  const expected =
    'd31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6' +
    '3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36' +
    '92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc' +
    '3ff4def08e4b7a9de576d26586cec64b6116' +
    '1ae10b594f09e26a7e902ecbd0600691';

  assert.equal(hex(chacha20poly1305(key, nonce, aad).encrypt(plaintext)), expected);
  assert.equal(hex(chacha20poly1305(key, nonce, aad).decrypt(unhex(expected))), hex(plaintext));
});

test('the nonce is four zero bytes then the counter little-endian', () => {
  assert.equal(hex(noiseNonceBytes(0n)), '000000000000000000000000');
  assert.equal(hex(noiseNonceBytes(1n)), '000000000100000000000000');
  assert.equal(hex(noiseNonceBytes(0x0102030405060708n)), '000000000807060504030201');
});

test('counter exhaustion is a hard error at the reserved 2^64-1', () => {
  // Pinned on the nonce function, not a `NoiseCipherState`: reaching 2^64-2
  // through a cipher would need a nonce-setting hook, and ephemeral injection
  // is the only hook this module has.
  assert.equal(hex(noiseNonceBytes(2n ** 64n - 2n)), '00000000feffffffffffffff');
  assert.throws(() => noiseNonceBytes(2n ** 64n - 1n), NoiseError);
  assert.throws(() => noiseNonceBytes(2n ** 64n), NoiseError);
  assert.throws(() => noiseNonceBytes(-1n), NoiseError);
});

test('a failed transport decrypt does not advance the counter', async () => {
  const { initiator, responder } = await completeHandshake();
  const first = initiator.session.send.encryptWithAd(EMPTY, unhex(VECTOR.messages[2].payload));
  const second = initiator.session.send.encryptWithAd(EMPTY, unhex(VECTOR.messages[4].payload));

  const receive = responder.session.receive;
  const forged = Uint8Array.from(first);
  forged[forged.length - 1] ^= 0x01;
  assert.throws(() => receive.decryptWithAd(EMPTY, forged), NoiseError);
  assert.equal(receive.nonce, 0n);

  // The real sender is not locked out by the injected frame.
  assert.equal(hex(receive.decryptWithAd(EMPTY, first)), VECTOR.messages[2].payload);
  assert.equal(hex(receive.decryptWithAd(EMPTY, second)), VECTOR.messages[4].payload);
  assert.equal(receive.nonce, 2n);
});

test('a transport message replayed at the wrong counter is rejected', async () => {
  const { initiator, responder } = await completeHandshake();
  const first = initiator.session.send.encryptWithAd(EMPTY, unhex(VECTOR.messages[2].payload));
  assert.equal(hex(responder.session.receive.decryptWithAd(EMPTY, first)), VECTOR.messages[2].payload);
  assert.throws(() => responder.session.receive.decryptWithAd(EMPTY, first), NoiseError);
});

test('mutating any byte of handshake message 1 is rejected', async () => {
  const valid = unhex(VECTOR.messages[0].ciphertext);
  for (let i = 0; i < valid.length; i++) {
    const mutated = Uint8Array.from(valid);
    mutated[i] ^= 0x01;
    const responder = await newResponder();
    await assert.rejects(responder.readMessage(mutated), NoiseError, `byte ${i}`);
  }
});

test('mutating any byte of handshake message 2 is rejected', async () => {
  const valid = unhex(VECTOR.messages[1].ciphertext);
  for (let i = 0; i < valid.length; i++) {
    const mutated = Uint8Array.from(valid);
    mutated[i] ^= 0x01;
    const initiator = await newInitiator();
    await initiator.writeMessage(unhex(VECTOR.messages[0].payload));
    await assert.rejects(initiator.readMessage(mutated), NoiseError, `byte ${i}`);
  }
});

test('a mismatched prologue fails the handshake', async () => {
  const initiator = await newInitiator();
  const responder = await newResponder({ prologue: unhex(`${VECTOR.resp_prologue}00`) });
  const message1 = await initiator.writeMessage(EMPTY);
  await assert.rejects(responder.readMessage(message1), NoiseError);
});

test('an initiator pointed at the wrong static key fails the handshake', async () => {
  // IK's whole point: the initiator commits to `rs` before speaking, so a
  // substituted Host static never decrypts.
  const wrong = await generateNoiseKeyPair();
  const initiator = await newInitiator({ remoteStaticPublicKey: wrong.publicKey });
  const responder = await newResponder();
  await assert.rejects(responder.readMessage(await initiator.writeMessage(EMPTY)), NoiseError);
});

test('an all-zero remote static is one terminal handshake failure', async () => {
  const initiator = await newInitiator({ remoteStaticPublicKey: new Uint8Array(32) });
  await assert.rejects(initiator.writeMessage(EMPTY), NoiseError);
  await assert.rejects(initiator.writeMessage(EMPTY), NoiseError);
  assert.equal(initiator.isComplete, false);
  assert.throws(() => initiator.session, NoiseError);
});

test('a remote static of the wrong length is rejected before any crypto', async () => {
  await assert.rejects(
    createNoiseInitiator({
      prologue: EMPTY,
      staticKeyPair: keys.initStatic,
      remoteStaticPublicKey: new Uint8Array(31),
    }),
    NoiseError,
  );
});

test('handshake messages are capped at 65,535 bytes on write and read', async () => {
  // Message 1 is 96 bytes of framing (`e`, the encrypted static, one tag).
  const maxPayload = NOISE_MAX_MESSAGE_LENGTH - 96;
  const initiator = await newInitiator();
  const responder = await newResponder();
  const message1 = await initiator.writeMessage(new Uint8Array(maxPayload));
  assert.equal(message1.length, NOISE_MAX_MESSAGE_LENGTH);
  assert.equal((await responder.readMessage(message1)).length, maxPayload);

  const tooBig = await newInitiator();
  await assert.rejects(tooBig.writeMessage(new Uint8Array(maxPayload + 1)), NoiseError);

  const reader = await newResponder();
  await assert.rejects(
    reader.readMessage(new Uint8Array(NOISE_MAX_MESSAGE_LENGTH + 1)),
    NoiseError,
  );
});

test('handshake steps only run in their pattern order', async () => {
  const initiator = await newInitiator();
  await assert.rejects(initiator.readMessage(new Uint8Array(48)), NoiseError);

  const responder = await newResponder();
  await assert.rejects(responder.writeMessage(EMPTY), NoiseError);

  const { initiator: done } = await completeHandshake();
  await assert.rejects(done.writeMessage(EMPTY), NoiseError);
});

test('a keyless CipherState is a passthrough, and a keyed one needs 32 bytes', () => {
  const empty = new NoiseCipherState();
  assert.equal(empty.hasKey, false);
  const data = Uint8Array.of(1, 2, 3);
  assert.equal(hex(empty.encryptWithAd(EMPTY, data)), '010203');
  assert.equal(hex(empty.decryptWithAd(EMPTY, data)), '010203');
  assert.equal(empty.nonce, 0n);
  assert.throws(() => new NoiseCipherState(new Uint8Array(31)), NoiseError);
});

test('a generated keypair round-trips through a real handshake', async () => {
  const host = await generateNoiseKeyPair();
  const client = await generateNoiseKeyPair();
  assert.equal(host.publicKey.length, 32);
  assert.equal(host.privateKey.extractable, false);

  const prologue = Uint8Array.of(0xde, 0xad, 0xbe, 0xef);
  const initiator = await createNoiseInitiator({
    prologue,
    staticKeyPair: client,
    remoteStaticPublicKey: host.publicKey,
  });
  const responder = await createNoiseResponder({ prologue, staticKeyPair: host });

  const hello = Uint8Array.of(0x01, 0x02);
  assert.equal(hex(await responder.readMessage(await initiator.writeMessage(hello))), '0102');
  assert.equal(hex(responder.remoteStaticPublicKey), hex(client.publicKey));
  assert.equal(hex(await initiator.readMessage(await responder.writeMessage(EMPTY))), '');

  assert.equal(
    hex(initiator.session.handshakeHash),
    hex(responder.session.handshakeHash),
  );
  const wire = initiator.session.send.encryptWithAd(EMPTY, hello);
  assert.equal(hex(responder.session.receive.decryptWithAd(EMPTY, wire)), '0102');
});
