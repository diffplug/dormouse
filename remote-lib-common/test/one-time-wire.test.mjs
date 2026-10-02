/**
 * The one-time rendezvous wire (docs/specs/one-time.md -> Wire contract): its
 * frame guards, its bounds, and the close codes both ends key copy on.
 *
 * The frames are a family of their own, so the other half of every guard test
 * here is that the relay's `e2e` guards refuse them and theirs refuse `e2e`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DIRECT_ONLY_DEADLINE_MS,
  DEFAULT_PAIRING_TTL_MS,
  MAX_E2E_CIPHERTEXT_LENGTH,
  MAX_ONE_TIME_FORWARDED,
  MAX_ONE_TIME_FRAME_LENGTH,
  ONE_TIME_EXPIRY_GRACE_MS,
  ONE_TIME_LINK_TTL_MS,
  RELAY_PING,
  RELAY_PING_INTERVAL_MS,
  RELAY_PONG,
  ONE_TIME_ROOM_PARAM,
  ONE_TIME_WS_ROUTES,
  WS_CLOSE_BURROW_REPLACED,
  WS_CLOSE_BURROW_REVOKED,
  WS_CLOSE_ONE_TIME_DEADLINE,
  WS_CLOSE_ONE_TIME_DEADLINE_REASON,
  WS_CLOSE_ONE_TIME_EXPIRED,
  WS_CLOSE_ONE_TIME_EXPIRED_REASON,
  WS_CLOSE_ONE_TIME_PEER_GONE,
  WS_CLOSE_ONE_TIME_PEER_GONE_REASON,
  WS_CLOSE_ONE_TIME_TAKEN,
  WS_CLOSE_ONE_TIME_TAKEN_REASON,
  WS_CLOSE_ONE_TIME_UNAVAILABLE,
  WS_CLOSE_ONE_TIME_UNAVAILABLE_REASON,
  WS_CLOSE_ONE_TIME_VIOLATION,
  WS_CLOSE_ONE_TIME_VIOLATION_REASON,
  WS_ROUTES,
  isE2eBurrowFrame,
  isE2eClientFrame,
  isE2eKind,
  isE2eRelayToBurrowFrame,
  isE2eRelayToClientFrame,
  isOneTimeBurrowFrame,
  isOneTimeClientFrame,
  isOneTimeRoomFrame,
} from '../dist/index.js';

const ROOM_ID = 'AAECAwQFBgcICQoLDA0ODw';
const EXPIRES_AT = 1_700_000_300_000;

const ROOM = { t: 'one-time-room', roomId: ROOM_ID, expiresAt: EXPIRES_AT };
const CLIENT = { t: 'one-time', step: 'init', ct: 'Zm9v' };
const BURROW = { t: 'one-time', step: 'response', ct: 'Zm9v' };

// --- Routes ------------------------------------------------------------------

test('the rendezvous routes live under the one-time API, apart from the relay socket routes', () => {
  assert.deepEqual(ONE_TIME_WS_ROUTES, { burrow: '/api/one-time/burrow', client: '/api/one-time/client' });
  assert.equal(ONE_TIME_ROOM_PARAM, 'room');
  for (const route of Object.values(ONE_TIME_WS_ROUTES)) {
    assert.equal(Object.values(WS_ROUTES).includes(route), false, route);
  }
});

// --- The room frame ------------------------------------------------------------

test('isOneTimeRoomFrame takes exactly a room id and a mintable expiry', () => {
  assert.equal(isOneTimeRoomFrame(ROOM), true);
  // The largest expiry whose whole seconds still fit the link's uint32 field.
  assert.equal(isOneTimeRoomFrame({ ...ROOM, expiresAt: 0xffff_ffff * 1000 + 999 }), true);
  for (const [why, frame] of [
    ['null', null],
    ['a string', 'one-time-room'],
    ['an array', [ROOM]],
    ['an extra key', { ...ROOM, extra: true }],
    ['a missing key', { t: ROOM.t, roomId: ROOM.roomId }],
    ['another tag', { ...ROOM, t: 'one-time' }],
    ['a short room id', { ...ROOM, roomId: ROOM_ID.slice(0, 21) }],
    ['a padded room id', { ...ROOM, roomId: `${ROOM_ID.slice(0, 21)}=` }],
    ['a string expiry', { ...ROOM, expiresAt: String(EXPIRES_AT) }],
    ['a zero expiry', { ...ROOM, expiresAt: 0 }],
    ['a negative expiry', { ...ROOM, expiresAt: -1 }],
    ['a NaN expiry', { ...ROOM, expiresAt: Number.NaN }],
    ['an infinite expiry', { ...ROOM, expiresAt: Number.POSITIVE_INFINITY }],
    ['an expiry past uint32 seconds', { ...ROOM, expiresAt: (0xffff_ffff + 1) * 1000 }],
  ]) {
    assert.equal(isOneTimeRoomFrame(frame), false, why);
  }
});

// --- The two ends' frames ----------------------------------------------------

test('isOneTimeClientFrame takes the phone steps and exactly three keys', () => {
  assert.equal(isOneTimeClientFrame(CLIENT), true);
  assert.equal(isOneTimeClientFrame({ ...CLIENT, step: 'transport' }), true);
  assert.equal(isOneTimeClientFrame({ ...CLIENT, ct: 'a'.repeat(MAX_E2E_CIPHERTEXT_LENGTH) }), true);
  for (const [why, frame] of [
    ['null', null],
    ['an array', [CLIENT]],
    ['an extra key', { ...CLIENT, roomId: ROOM_ID }],
    ['a missing ct', { t: CLIENT.t, step: CLIENT.step }],
    ['the room tag', { ...CLIENT, t: 'one-time-room' }],
    ['the relay tag', { ...CLIENT, t: 'e2e' }],
    // `response` is the Burrow's step; a phone claiming it is not this frame.
    ['the Burrow step', { ...CLIENT, step: 'response' }],
    ['an unknown step', { ...CLIENT, step: 'init2' }],
    ['an empty ct', { ...CLIENT, ct: '' }],
    ['a ct outside base64url', { ...CLIENT, ct: 'not/base64url+' }],
    ['a numeric ct', { ...CLIENT, ct: 42 }],
    ['an over-long ct', { ...CLIENT, ct: 'a'.repeat(MAX_E2E_CIPHERTEXT_LENGTH + 1) }],
  ]) {
    assert.equal(isOneTimeClientFrame(frame), false, why);
  }
});

test('isOneTimeBurrowFrame takes the Burrow steps and exactly three keys', () => {
  assert.equal(isOneTimeBurrowFrame(BURROW), true);
  assert.equal(isOneTimeBurrowFrame({ ...BURROW, step: 'transport' }), true);
  for (const [why, frame] of [
    ['null', null],
    ['an extra key', { ...BURROW, clientId: 'c-1' }],
    ['a missing step', { t: BURROW.t, ct: BURROW.ct }],
    ['the relay tag', { ...BURROW, t: 'e2e' }],
    // `init` is the phone's own step; a Burrow never sends one.
    ['the phone step', { ...BURROW, step: 'init' }],
    ['an empty ct', { ...BURROW, ct: '' }],
    ['an over-long ct', { ...BURROW, ct: 'a'.repeat(MAX_E2E_CIPHERTEXT_LENGTH + 1) }],
  ]) {
    assert.equal(isOneTimeBurrowFrame(frame), false, why);
  }
});

test('the one-time family and the relay envelope refuse each other', () => {
  // A one-time room is never a relay route: no `e2e` guard admits a one-time
  // frame, and no one-time guard admits an `e2e` one, so neither the Relay
  // nor `BurrowRuntime` can be steered into this ceremony by a frame.
  assert.equal(isE2eKind('one-time'), false);
  for (const frame of [CLIENT, BURROW, ROOM, { ...CLIENT, kind: 'one-time', burrowId: ROOM_ID, id: ROOM_ID }]) {
    assert.equal(isE2eClientFrame(frame), false, JSON.stringify(frame));
    assert.equal(isE2eBurrowFrame(frame), false, JSON.stringify(frame));
    assert.equal(isE2eRelayToBurrowFrame({ ...frame, clientId: 'c-1' }), false, JSON.stringify(frame));
    assert.equal(isE2eRelayToClientFrame(frame), false, JSON.stringify(frame));
  }
  const e2e = { t: 'e2e', burrowId: ROOM_ID, kind: 'connection', id: ROOM_ID, step: 'init', ct: 'Zm9v' };
  assert.equal(isE2eClientFrame(e2e), true);
  assert.equal(isOneTimeClientFrame(e2e), false);
  assert.equal(isOneTimeBurrowFrame({ ...e2e, step: 'response' }), false);
  assert.equal(isOneTimeRoomFrame(e2e), false);
});

// --- Bounds and timings ----------------------------------------------------

test('the raw frame bound admits every legal frame and the slack is small', () => {
  assert.equal(MAX_ONE_TIME_FRAME_LENGTH, MAX_E2E_CIPHERTEXT_LENGTH + 512);
  // The longest legal frame of each shape, serialized as a sender would.
  const maximal = 'a'.repeat(MAX_E2E_CIPHERTEXT_LENGTH);
  for (const frame of [
    { t: 'one-time', step: 'transport', ct: maximal },
    { t: 'one-time', step: 'response', ct: maximal },
    { t: 'one-time-room', roomId: ROOM_ID, expiresAt: Number.MAX_SAFE_INTEGER },
  ]) {
    assert.ok(JSON.stringify(frame).length <= MAX_ONE_TIME_FRAME_LENGTH, frame.t);
  }
});

test('the room forwards a handshake, never a session', () => {
  assert.equal(MAX_ONE_TIME_FORWARDED, 32);
});

test('the timings: a pairing-length link, a short grace, and a direct deadline inside it', () => {
  assert.equal(ONE_TIME_LINK_TTL_MS, DEFAULT_PAIRING_TTL_MS);
  assert.equal(ONE_TIME_LINK_TTL_MS, 5 * 60 * 1000);
  assert.equal(ONE_TIME_EXPIRY_GRACE_MS, 45_000);
  // A confirmation at the last second of the link still has its whole direct
  // deadline before the room's hard deadline closes the rendezvous.
  assert.ok(DIRECT_ONLY_DEADLINE_MS < ONE_TIME_EXPIRY_GRACE_MS);
});

test('the rendezvous keepalive is the relay socket\'s: two fixed strings no frame can be', () => {
  assert.equal(RELAY_PING, 'ping');
  assert.equal(RELAY_PONG, 'pong');
  assert.equal(RELAY_PING_INTERVAL_MS, 30_000);
  // Neither parses as a frame, so neither can be mistaken for one.
  for (const text of [RELAY_PING, RELAY_PONG]) {
    assert.throws(() => JSON.parse(text));
  }
});

// --- Close codes -------------------------------------------------------------

test('each close code is distinct, application-private, and carries a short reason', () => {
  const codes = [
    [WS_CLOSE_ONE_TIME_EXPIRED, WS_CLOSE_ONE_TIME_EXPIRED_REASON, 4010],
    [WS_CLOSE_ONE_TIME_TAKEN, WS_CLOSE_ONE_TIME_TAKEN_REASON, 4011],
    [WS_CLOSE_ONE_TIME_UNAVAILABLE, WS_CLOSE_ONE_TIME_UNAVAILABLE_REASON, 4012],
    [WS_CLOSE_ONE_TIME_PEER_GONE, WS_CLOSE_ONE_TIME_PEER_GONE_REASON, 4013],
    [WS_CLOSE_ONE_TIME_DEADLINE, WS_CLOSE_ONE_TIME_DEADLINE_REASON, 4014],
    [WS_CLOSE_ONE_TIME_VIOLATION, WS_CLOSE_ONE_TIME_VIOLATION_REASON, 4015],
  ];
  const seen = new Set([WS_CLOSE_BURROW_REPLACED, WS_CLOSE_BURROW_REVOKED]);
  for (const [code, reason, expected] of codes) {
    assert.equal(code, expected);
    assert.equal(seen.has(code), false, `${code} collides`);
    seen.add(code);
    // A close reason is at most 123 bytes of UTF-8; ASCII keeps bytes = length.
    assert.match(reason, /^[ -~]{1,123}$/, reason);
  }
  assert.equal(new Set(codes.map(([, reason]) => reason)).size, codes.length);
});
