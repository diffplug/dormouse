/**
 * The WebCrypto Web Push sender (`src/remote/web-push.ts`; docs/specs/hosted.md
 * -> "Relay").
 *
 * Every expected value comes from an independent source: the vendored RFC 8291
 * Appendix A vector, Node's own `crypto` (ECDH, HKDF, AES-128-GCM) decrypting
 * what the sender produced, and WebCrypto verifying the VAPID signature against
 * a key Node generated — never from the implementation under test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, generateKeyPairSync, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  MAX_WEB_PUSH_PLAINTEXT_LENGTH,
  VAPID_JWT_LIFETIME_S,
  WEB_PUSH_RECORD_SIZE,
  defaultVapidSubject,
  encryptWebPush,
  generateNoiseKeyPair,
  isLoopbackVapidSubject,
  openPush,
  sealPush,
  toBase64Url,
  utf8Encode,
  vapidSigner,
  webPushRequest,
} from '../dist/index.js';

const vector = JSON.parse(
  readFileSync(new URL('./vectors/rfc8291-appendix-a.json', import.meta.url), 'utf8'),
);
const b64u = (text) => new Uint8Array(Buffer.from(text, 'base64url'));

test('encryption reproduces the RFC 8291 Appendix A message byte for byte', async () => {
  const body = await encryptWebPush(
    b64u(vector.plaintext),
    { p256dh: vector.ua_public, auth: vector.auth_secret },
    {
      salt: b64u(vector.salt),
      senderKeyPair: { privateKey: b64u(vector.as_private), publicKey: b64u(vector.as_public) },
    },
  );
  assert.equal(toBase64Url(body), vector.body);
});

test('padded and standard-alphabet subscription keys encrypt the same message', async () => {
  // Browsers emit unpadded base64url; a padded or `+`/`/` serialization is the
  // same key, and the registration bounds admit it.
  const standard = (text) => Buffer.from(text, 'base64url').toString('base64');
  const body = await encryptWebPush(
    b64u(vector.plaintext),
    { p256dh: standard(vector.ua_public), auth: standard(vector.auth_secret) },
    {
      salt: b64u(vector.salt),
      senderKeyPair: { privateKey: b64u(vector.as_private), publicKey: b64u(vector.as_public) },
    },
  );
  assert.equal(toBase64Url(body), vector.body);
});

/** A subscription as a browser holds it: a P-256 keypair and an auth secret, from Node. */
function browserSubscription() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = new Uint8Array(16);
  crypto.getRandomValues(auth);
  return {
    ecdh,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: toBase64Url(auth) },
  };
}

/**
 * RFC 8291 decryption written against Node's `crypto`, not the code under
 * test: the header's salt and sender key, ECDH, two HKDF steps, AES-128-GCM,
 * and the last-record delimiter.
 */
function decrypt(body, { ecdh, keys }) {
  const bytes = Buffer.from(body);
  const salt = bytes.subarray(0, 16);
  const recordSize = bytes.readUInt32BE(16);
  const idLength = bytes[20];
  const senderPublic = bytes.subarray(21, 21 + idLength);
  const record = bytes.subarray(21 + idLength);
  assert.equal(recordSize, 4096);
  assert.equal(idLength, 65);
  assert.ok(record.length <= recordSize);
  const uaPublic = Buffer.from(keys.p256dh, 'base64url');
  const ecdhSecret = ecdh.computeSecret(senderPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, Buffer.from(keys.auth, 'base64url'), keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  assert.equal(padded.at(-1), 2, 'one record, ending in the last-record delimiter');
  return padded.subarray(0, -1);
}

test('a sealed envelope survives the round trip through an independent decryptor', async () => {
  const burrow = await generateNoiseKeyPair();
  const client = await generateNoiseKeyPair();
  const notification = utf8Encode(JSON.stringify({ title: 'build finished', body: 'zsh', tag: 'pty-1' }));
  const sealed = await sealPush({
    burrowStaticPrivateKey: burrow.privateKey,
    clientStaticPublicKey: client.publicKey,
    plaintext: notification,
  });
  const payload = utf8Encode(JSON.stringify({ burrowId: 'b'.repeat(22), ...sealed }));

  const subscription = browserSubscription();
  const first = await encryptWebPush(payload, subscription.keys);
  const second = await encryptWebPush(payload, subscription.keys);
  // A fresh salt and sender key per message.
  assert.notDeepEqual(first.subarray(0, 86), second.subarray(0, 86));

  const recovered = JSON.parse(decrypt(first, subscription).toString('utf8'));
  assert.equal(recovered.burrowId, 'b'.repeat(22));
  const opened = await openPush({
    clientStaticPrivateKey: client.privateKey,
    burrowStaticPublicKey: burrow.publicKey,
    sealed: { v: recovered.v, salt: recovered.salt, ct: recovered.ct },
  });
  assert.deepEqual(opened, notification);
});

test('a payload past one record, or a malformed subscription key, is refused', async () => {
  const { keys } = browserSubscription();
  assert.equal(MAX_WEB_PUSH_PLAINTEXT_LENGTH, WEB_PUSH_RECORD_SIZE - 86 - 1 - 16);
  await encryptWebPush(new Uint8Array(MAX_WEB_PUSH_PLAINTEXT_LENGTH), keys);
  await assert.rejects(encryptWebPush(new Uint8Array(MAX_WEB_PUSH_PLAINTEXT_LENGTH + 1), keys));
  const point = Buffer.from(keys.p256dh, 'base64url');
  for (const bad of [
    { ...keys, p256dh: point.subarray(1).toString('base64url') },
    { ...keys, p256dh: Buffer.concat([Buffer.from([3]), point.subarray(1)]).toString('base64url') },
    { ...keys, p256dh: 'not base64!' },
    { ...keys, auth: toBase64Url(new Uint8Array(15)) },
  ])
    await assert.rejects(encryptWebPush(new Uint8Array(8), bad), JSON.stringify(bad));
});

/** A VAPID keypair from Node, in the encoding the Worker secrets hold. */
function nodeVapidKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { publicKey: point.toString('base64url'), privateKey: jwk.d };
}

test('the VAPID JWT verifies under the public key and carries exactly aud, exp, and sub', async () => {
  const keys = nodeVapidKeys();
  const signer = await vapidSigner(keys);
  assert.ok(signer);
  assert.equal(signer.publicKey, keys.publicKey);
  const now = Date.UTC(2026, 9, 1, 12, 0, 0);
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc:def?x=1';
  const authorization = await signer.authorization(endpoint, 'https://relay.example.test', now);

  const match = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(
    authorization,
  );
  assert.ok(match, authorization);
  const [, header, claims, signature, k] = match;
  assert.equal(k, keys.publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), {
    aud: 'https://fcm.googleapis.com',
    exp: now / 1000 + VAPID_JWT_LIFETIME_S,
    sub: 'https://relay.example.test',
  });
  assert.ok(VAPID_JWT_LIFETIME_S <= 24 * 60 * 60);

  const verifyKey = await crypto.subtle.importKey(
    'raw',
    b64u(keys.publicKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const verify = (data) =>
    crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, b64u(signature), utf8Encode(data));
  assert.equal(await verify(`${header}.${claims}`), true);
  assert.equal(await verify(`${header}.${claims}x`), false);
});

test('a malformed or mismatched VAPID pair yields no signer', async () => {
  const keys = nodeVapidKeys();
  const other = nodeVapidKeys();
  assert.equal(await vapidSigner({ publicKey: keys.publicKey, privateKey: other.privateKey }), null);
  assert.equal(await vapidSigner({ publicKey: `${keys.publicKey}=`, privateKey: keys.privateKey }), null);
  assert.equal(await vapidSigner({ publicKey: keys.publicKey, privateKey: '' }), null);
  assert.equal(await vapidSigner({ publicKey: '', privateKey: keys.privateKey }), null);
  assert.equal(
    await vapidSigner({ publicKey: keys.publicKey, privateKey: toBase64Url(new Uint8Array(32)) }),
    null,
  );
  assert.ok(await vapidSigner(keys));
});

test('noncanonical trailing bits in either VAPID key yield no signer', async () => {
  const keys = nodeVapidKeys();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (const field of ['publicKey', 'privateKey']) {
    const value = keys[field];
    const noncanonical = value.slice(0, -1) + alphabet[alphabet.indexOf(value.at(-1)) | 1];
    assert.notEqual(noncanonical, value);
    assert.deepEqual(Buffer.from(noncanonical, 'base64url'), Buffer.from(value, 'base64url'));
    assert.equal(await vapidSigner({ ...keys, [field]: noncanonical }), null);
  }
});

test('a push request carries the encrypted body, the VAPID authorization, TTL, and urgency', async () => {
  const signer = await vapidSigner(nodeVapidKeys());
  const subscription = browserSubscription();
  const endpoint = 'https://web.push.apple.com/QGuQyavXutnMH-5';
  const authorization = await signer.authorization(endpoint, 'https://relay.example.test', Date.now());
  const { headers, body } = await webPushRequest(subscription.keys, utf8Encode('{"v":1}'), {
    authorization,
    ttlSeconds: 300,
  });
  assert.deepEqual(Object.keys(headers).sort(), [
    'authorization',
    'content-encoding',
    'content-type',
    'ttl',
    'urgency',
  ]);
  assert.equal(headers.authorization, authorization);
  assert.equal(headers['content-encoding'], 'aes128gcm');
  assert.equal(headers.ttl, '300');
  assert.equal(headers.urgency, 'high');
  assert.equal(decrypt(body, subscription).toString('utf8'), '{"v":1}');
});

test('the default VAPID subject is an https origin that names no loopback host', () => {
  assert.equal(defaultVapidSubject('https://relay.dormouse.sh'), 'https://relay.dormouse.sh');
  assert.equal(defaultVapidSubject('https://relay.dormouse.sh/'), 'https://relay.dormouse.sh');
  for (const origin of ['http://localhost:8787', 'https://localhost', 'https://127.0.0.1', 'https://a.localhost', 'nope'])
    assert.equal(defaultVapidSubject(origin), null, origin);
  assert.equal(isLoopbackVapidSubject('mailto:admin@localhost'), true);
  assert.equal(isLoopbackVapidSubject('mailto:admin@example.com'), false);
});
