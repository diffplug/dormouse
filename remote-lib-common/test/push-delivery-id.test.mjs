/**
 * Delivery ids a Relay can check (docs/specs/remote-security-model.md ->
 * Burrow Authorization): a Burrow tags each id under a key derived from its
 * `burrowToken`, so a Relay registers a subscription only for an id that
 * Burrow minted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

import {
  DELIVERY_ID_LENGTH,
  deliveryIdMintedBy,
  fromBase64Url,
  isPushDeliveryId,
  mintPushDeliveryId,
  pushDeliveryKey,
  randomBase64Url,
  toBase64Url,
} from '../dist/index.js';

const TOKEN = randomBase64Url(32);
const BURROW = randomBase64Url(16);

test('a minted id has the delivery-id shape and verifies for its Burrow', async () => {
  const key = await pushDeliveryKey(TOKEN);
  const id = await mintPushDeliveryId(key, BURROW);
  assert.equal(id.length, DELIVERY_ID_LENGTH);
  assert.ok(isPushDeliveryId(id));
  assert.equal(await deliveryIdMintedBy(key, BURROW, id), true);
  assert.notEqual(await mintPushDeliveryId(key, BURROW), id);
});

test('a minted id is its nonce then the documented HMAC tag, rebuilt with node:crypto', async () => {
  // Rebuilt without this package: the minter (a Burrow) and the checker (a
  // self-host or Hosted Relay) ship apart, so a round trip proves too little.
  const key = await pushDeliveryKey(TOKEN);
  const id = Buffer.from(fromBase64Url(await mintPushDeliveryId(key, BURROW)));
  const nonce = id.subarray(0, 16);
  const framed = [];
  for (const part of [Buffer.from('dormouse/push-delivery/v1'), Buffer.from(BURROW), nonce]) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(part.length);
    framed.push(length, part);
  }
  const tag = createHmac('sha256', Buffer.from(key)).update(Buffer.concat(framed)).digest().subarray(0, 16);
  assert.deepEqual(id.subarray(16), tag);
});

test('the key is the SHA-256 of the token, the digest Hosted stores', async () => {
  const key = await pushDeliveryKey(TOKEN);
  assert.equal(Buffer.from(key).toString('hex'), createHash('sha256').update(TOKEN).digest('hex'));
});

test('an id verifies under no other Burrow, no other token, and no random id', async () => {
  const key = await pushDeliveryKey(TOKEN);
  const id = await mintPushDeliveryId(key, BURROW);
  assert.equal(await deliveryIdMintedBy(key, randomBase64Url(16), id), false);
  assert.equal(await deliveryIdMintedBy(await pushDeliveryKey(randomBase64Url(32)), BURROW, id), false);
  assert.equal(await deliveryIdMintedBy(key, BURROW, randomBase64Url(32)), false);

  const bytes = fromBase64Url(id);
  for (const at of [0, 15, 16, 31]) {
    const flipped = bytes.slice();
    flipped[at] ^= 1;
    assert.equal(await deliveryIdMintedBy(key, BURROW, toBase64Url(flipped)), false, `byte ${at}`);
  }
  // The right length, with the last character's spare bits set.
  const noncanonical = `${id.slice(0, 42)}${id.endsWith('B') ? 'C' : 'B'}`;
  for (const malformed of [undefined, 42, '', id.slice(1), `${id}A`, noncanonical]) {
    assert.equal(await deliveryIdMintedBy(key, BURROW, malformed), false);
  }
});
