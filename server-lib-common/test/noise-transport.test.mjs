/**
 * The E2E transport framing (docs/specs/server.md -> Relay -> "E2E framing").
 * The relay-integrated half — the same framing through a real server — is
 * `server/test/e2e-relay.test.mjs`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_LENGTH_PREFIX_SIZE,
  CONTROL_PAYLOAD_SIZE,
  E2E_PROLOGUE_DOMAIN,
  KEEPALIVE_BODY_SIZE,
  MAX_APP_MESSAGE_LENGTH,
  MAX_STREAM_BODY_LENGTH,
  NOISE_MAX_MESSAGE_LENGTH,
  NOISE_TAG_LENGTH,
  NoiseError,
  NoiseTransportSession,
  StreamReassembler,
  TRANSPORT_KIND_CONTROL,
  TRANSPORT_KIND_KEEPALIVE,
  TRANSPORT_KIND_STREAM,
  chunkAppMessage,
  createNoiseInitiator,
  createNoiseResponder,
  decodeTransportPlaintext,
  e2eConnectionPrologue,
  e2ePairingPrologue,
  encodeTransportPlaintext,
  generateNoiseKeyPair,
  lengthPrefixedConcat,
  utf8Encode,
  writeUint32BE,
} from '../dist/index.js';

/** A completed IK handshake, wrapped both ends in transport sessions. */
async function established({ prologue = e2eConnectionPrologue('h', 'c') } = {}) {
  const hostStatic = await generateNoiseKeyPair();
  const clientStatic = await generateNoiseKeyPair();
  const initiator = await createNoiseInitiator({
    prologue,
    staticKeyPair: clientStatic,
    remoteStaticPublicKey: hostStatic.publicKey,
  });
  const responder = await createNoiseResponder({ prologue, staticKeyPair: hostStatic });
  await responder.readMessage(await initiator.writeMessage());
  await initiator.readMessage(await responder.writeMessage());
  return {
    client: new NoiseTransportSession(initiator.session),
    host: new NoiseTransportSession(responder.session),
    // The raw `Split` states, so a test can put a plaintext on the wire that
    // authenticates and is still not framing. The wrapper holds these exact
    // objects, so the counters stay shared.
    clientNoise: initiator.session,
    clientStatic,
    hostStatic,
  };
}

const EMPTY = new Uint8Array(0);

// --- Plaintext framing -----------------------------------------------------

test('the kind byte leads every transport plaintext', () => {
  assert.equal(encodeTransportPlaintext({ kind: 'keepalive' })[0], TRANSPORT_KIND_KEEPALIVE);
  const stream = encodeTransportPlaintext({ kind: 'stream', body: new Uint8Array(3) });
  assert.equal(stream[0], TRANSPORT_KIND_STREAM);
  assert.equal(encodeTransportPlaintext({ kind: 'control', value: {} })[0], TRANSPORT_KIND_CONTROL);
});

test('a keepalive is the kind byte and 32 zero bytes, nothing else', () => {
  const encoded = encodeTransportPlaintext({ kind: 'keepalive' });
  assert.equal(encoded.length, 1 + KEEPALIVE_BODY_SIZE);
  assert.ok(encoded.subarray(1).every((b) => b === 0));
  assert.deepEqual(decodeTransportPlaintext(encoded), { kind: 'keepalive' });

  // Any other length, or a non-zero byte, is not a keepalive.
  assert.throws(() => decodeTransportPlaintext(Uint8Array.of(TRANSPORT_KIND_KEEPALIVE)), NoiseError);
  const dirty = encodeTransportPlaintext({ kind: 'keepalive' });
  dirty[5] = 1;
  assert.throws(() => decodeTransportPlaintext(dirty), NoiseError);
});

test('a control message is padded to exactly the control payload size', () => {
  const small = encodeTransportPlaintext({ kind: 'control', value: { a: 1 } });
  const verbose = { verbose: 'x'.repeat(3000) };
  const large = encodeTransportPlaintext({ kind: 'control', value: verbose });
  assert.equal(small.length, 1 + CONTROL_PAYLOAD_SIZE);
  assert.equal(large.length, small.length, 'every control message is one size');
  assert.deepEqual(decodeTransportPlaintext(small), { kind: 'control', value: { a: 1 } });
});

test('control decoding rejects a wrong length, non-JSON, and a non-object', () => {
  const short = encodeTransportPlaintext({ kind: 'control', value: {} }).subarray(0, 100);
  assert.throws(() => decodeTransportPlaintext(short), NoiseError);

  const body = new Uint8Array(1 + CONTROL_PAYLOAD_SIZE);
  body[0] = TRANSPORT_KIND_CONTROL;
  body.set(utf8Encode('not json'), 1);
  assert.throws(() => decodeTransportPlaintext(body), NoiseError);

  for (const json of ['[1,2]', '"a string"', '42', 'null']) {
    const framed = new Uint8Array(1 + CONTROL_PAYLOAD_SIZE);
    framed[0] = TRANSPORT_KIND_CONTROL;
    framed.set(utf8Encode(json), 1);
    assert.throws(() => decodeTransportPlaintext(framed), NoiseError, json);
  }
});

test('a control message larger than the payload size is refused, not truncated', () => {
  assert.throws(
    () =>
      encodeTransportPlaintext({
        kind: 'control',
        value: { big: 'x'.repeat(CONTROL_PAYLOAD_SIZE) },
      }),
    NoiseError,
  );
});

test('an unknown kind byte is a framing violation', () => {
  assert.throws(() => decodeTransportPlaintext(Uint8Array.of(0x03, 1, 2)), NoiseError);
  assert.throws(() => decodeTransportPlaintext(new Uint8Array(0)), NoiseError);
});

// --- The application stream ------------------------------------------------

test('the stream body cap keeps a Noise message inside 65535 bytes', () => {
  assert.equal(MAX_STREAM_BODY_LENGTH + NOISE_TAG_LENGTH + 1, NOISE_MAX_MESSAGE_LENGTH);
});

test('a chunked message reassembles byte-exact across many bodies', () => {
  const message = new Uint8Array(300_000);
  for (let i = 0; i < message.length; i++) message[i] = (i * 7) & 0xff;
  const bodies = chunkAppMessage(message);
  assert.ok(bodies.length > 4, 'a 300 KB message spans several Noise messages');
  assert.ok(bodies.every((body) => body.length <= MAX_STREAM_BODY_LENGTH));

  const reassembler = new StreamReassembler();
  const out = [];
  for (const body of bodies) out.push(...reassembler.push(body));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], message);
});

test('several messages packed into one body all come out, in order', () => {
  const a = utf8Encode('first');
  const b = utf8Encode('second');
  const packed = new Uint8Array([...chunkAppMessage(a)[0], ...chunkAppMessage(b)[0]]);
  const messages = new StreamReassembler().push(packed);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], a);
  assert.deepEqual(messages[1], b);
});

test('a partial message yields nothing until it completes', () => {
  const bodies = chunkAppMessage(new Uint8Array(200_000));
  const reassembler = new StreamReassembler();
  for (const body of bodies.slice(0, -1)) {
    assert.deepEqual(reassembler.push(body), [], 'no message before the last body');
  }
  assert.equal(reassembler.push(bodies.at(-1)).length, 1);
});

test('a zero-length application message round-trips', () => {
  const bodies = chunkAppMessage(new Uint8Array(0));
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].length, APP_LENGTH_PREFIX_SIZE);
  assert.deepEqual(new StreamReassembler().push(bodies[0]), [new Uint8Array(0)]);
});

test('a declared length over the 1 MiB cap is a hard failure', () => {
  // The prefix alone is enough: the declared length is rejected on the push
  // that completes it, long before that many bytes could be queued.
  assert.throws(
    () => new StreamReassembler().push(lengthPrefix(MAX_APP_MESSAGE_LENGTH + 1)),
    NoiseError,
  );
  const maxUint32 = Uint8Array.of(0xff, 0xff, 0xff, 0xff);
  assert.throws(() => new StreamReassembler().push(maxUint32), NoiseError);
});

test('a length prefix split across bodies is still read, and still capped', () => {
  const reassembler = new StreamReassembler();
  const prefix = lengthPrefix(MAX_APP_MESSAGE_LENGTH + 1);
  for (const byte of prefix.subarray(0, 3)) {
    assert.deepEqual(reassembler.push(Uint8Array.of(byte)), [], 'no verdict on a partial prefix');
  }
  assert.throws(() => reassembler.push(prefix.subarray(3)), NoiseError);
});

test('a message split into one-byte bodies reassembles, in linear time', () => {
  // `MAX_STREAM_BODY_LENGTH` is a maximum, not a minimum: a peer may split one
  // message this finely, and re-concatenating on every push would be quadratic.
  const message = new Uint8Array(40_000);
  for (let i = 0; i < message.length; i++) message[i] = (i * 13) & 0xff;
  const reassembler = new StreamReassembler();
  const out = [];
  for (const body of chunkAppMessage(message)) {
    for (const byte of body) out.push(...reassembler.push(Uint8Array.of(byte)));
  }
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], message);
});

/** The 4-byte big-endian application-message length prefix for `value`. */
function lengthPrefix(value) {
  const prefix = new Uint8Array(APP_LENGTH_PREFIX_SIZE);
  writeUint32BE(prefix, 0, value);
  return prefix;
}

test('the chunker refuses to send more than the cap', () => {
  const overCap = new Uint8Array(MAX_APP_MESSAGE_LENGTH + 1);
  assert.throws(() => chunkAppMessage(overCap), NoiseError);
});

test('a stream body larger than one Noise message is refused on both sides', () => {
  const body = new Uint8Array(MAX_STREAM_BODY_LENGTH + 1);
  assert.throws(() => encodeTransportPlaintext({ kind: 'stream', body }), NoiseError);
  assert.throws(() => new StreamReassembler().push(body), NoiseError);
});

// --- Prologues -------------------------------------------------------------

test('the connection prologue is the domain, kind, hostId, and connection id', () => {
  assert.deepEqual(
    e2eConnectionPrologue('host-1', 'conn-1'),
    lengthPrefixedConcat(
      [E2E_PROLOGUE_DOMAIN, 'connection', 'host-1', 'conn-1'].map((f) => utf8Encode(f)),
    ),
  );
});

test('the pairing prologue binds every invitation field, positionally', () => {
  assert.deepEqual(
    e2ePairingPrologue('host-1', ['inv', 'exp']),
    lengthPrefixedConcat(
      [E2E_PROLOGUE_DOMAIN, 'pairing', 'host-1', 'inv', 'exp'].map((f) => utf8Encode(f)),
    ),
  );
  // Length prefixes are what make the fields un-mergeable: two different
  // splittings of the same characters are different prologues.
  assert.notDeepEqual(e2ePairingPrologue('h', ['ab', 'c']), e2ePairingPrologue('h', ['a', 'bc']));
  // The kind is bound, so a pairing transcript cannot be replayed as a connection.
  assert.notDeepEqual(e2ePairingPrologue('h', ['x']), e2eConnectionPrologue('h', 'x'));
});

// --- The session -----------------------------------------------------------

test('keepalive, control, and app messages round-trip through a real handshake', async () => {
  const { client, host } = await established();
  assert.deepEqual(client.handshakeHash, host.handshakeHash);

  assert.deepEqual(host.receive(client.sendKeepalive()), { kind: 'keepalive' });
  assert.deepEqual(host.receive(client.sendControl({ hello: 'world' })), {
    kind: 'control',
    value: { hello: 'world' },
  });

  const payload = utf8Encode('remote-api rides in here');
  const [ct] = client.sendApp(payload);
  assert.deepEqual(host.receive(ct), { kind: 'app', messages: [payload] });

  // And back the other way, on the Host's own send state.
  const reply = utf8Encode('and back');
  assert.deepEqual(client.receive(host.sendApp(reply)[0]), { kind: 'app', messages: [reply] });
});

test('a 100 KiB application message reassembles byte-exact over the wire', async () => {
  const { client, host } = await established();
  const message = new Uint8Array(100 * 1024);
  for (let i = 0; i < message.length; i++) message[i] = (i * 31) & 0xff;

  const ciphertexts = client.sendApp(message);
  assert.ok(ciphertexts.length > 1, 'spans more than one Noise message');
  assert.ok(ciphertexts.every((ct) => ct.length <= NOISE_MAX_MESSAGE_LENGTH));

  const received = [];
  for (const ct of ciphertexts) received.push(...host.receive(ct).messages);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], message);
});

test('the send and receive states are directional: a reflected frame is rejected', async () => {
  const { client, host } = await established();
  const ct = client.sendKeepalive();
  assert.throws(() => client.receive(ct), NoiseError, 'a sender cannot read its own frame');
  assert.equal(client.isPoisoned, true);
  // The peer is unaffected — but the frame is now at the wrong counter for it.
  assert.deepEqual(host.receive(ct), { kind: 'keepalive' });
});

test('a replayed frame poisons the session permanently', async () => {
  const { client, host } = await established();
  const first = client.sendKeepalive();
  const second = client.sendKeepalive();
  assert.deepEqual(host.receive(first), { kind: 'keepalive' });

  assert.throws(() => host.receive(first), NoiseError, 'replay must not decrypt');
  assert.equal(host.isPoisoned, true);
  // Every later call throws, including the frame that would have been valid.
  assert.throws(() => host.receive(second), NoiseError);
  assert.throws(() => host.sendKeepalive(), NoiseError);
});

test('a reordered frame poisons the session', async () => {
  const { client, host } = await established();
  const first = client.sendKeepalive();
  const second = client.sendKeepalive();
  assert.throws(() => host.receive(second), NoiseError, 'a gap is a decrypt failure');
  assert.throws(() => host.receive(first), NoiseError);
});

test('a failed decrypt does not advance the receive counter', async () => {
  const { client, host } = await established();
  const ct = client.sendKeepalive();
  const tampered = new Uint8Array(ct);
  tampered[0] ^= 0x01;
  const before = host.receiveNonce;
  assert.throws(() => host.receive(tampered), NoiseError);
  assert.equal(host.receiveNonce, before, 'one injected frame must not lock out the real sender');
});

test('a framing violation poisons the session even though the ciphertext was valid', async () => {
  const { client, host, clientNoise } = await established();
  // A plaintext that authenticates perfectly and is still not framing: the
  // Noise layer is happy, so only the decoder can reject it.
  const ct = clientNoise.send.encryptWithAd(EMPTY, Uint8Array.of(0x7f, 1, 2));
  assert.throws(() => host.receive(ct), NoiseError);
  assert.equal(host.isPoisoned, true);
  assert.throws(() => host.receive(client.sendKeepalive()), NoiseError, 'poison is permanent');
});

test('the transcript binds the prologue: a mismatch fails message 1', async () => {
  const hostStatic = await generateNoiseKeyPair();
  const clientStatic = await generateNoiseKeyPair();
  const initiator = await createNoiseInitiator({
    prologue: e2eConnectionPrologue('host-1', 'conn-1'),
    staticKeyPair: clientStatic,
    remoteStaticPublicKey: hostStatic.publicKey,
  });
  const responder = await createNoiseResponder({
    prologue: e2eConnectionPrologue('host-1', 'conn-2'),
    staticKeyPair: hostStatic,
  });
  const message1 = await initiator.writeMessage();
  await assert.rejects(() => responder.readMessage(message1), NoiseError);
});
