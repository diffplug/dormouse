import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  API_ROUTES,
  E2E_ID_LENGTH,
  ENROLL_USER_CODE_ALPHABET,
  enrollUserCode,
  isEnrollUserCode,
  normalizeEnrollUserCode,
  MAX_E2E_CIPHERTEXT_LENGTH,
  MAX_CLIENT_ID_LENGTH,
  MAX_PUSH_QUERY_DELIVERY_IDS,
  MAX_TERMINAL_DIMENSION,
  NOISE_MAX_MESSAGE_LENGTH,
  clampTerminalDimension,
  isE2eCiphertext,
  isE2eClientFrame,
  isE2eBurrowFrame,
  isE2eRelayToClientFrame,
  isE2eId,
  isE2eRelayToBurrowFrame,
  isSetupTokenResponse,
  isBurrowEnrollBeginResponse,
  isBurrowEnrollPollResponse,
  MAX_ENROLL_POLL_INTERVAL_S,
  MIN_ENROLL_POLL_INTERVAL_S,
  RELAY_BEARER_LENGTH,
  pushSubscriptionDeletePath,
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

const MINT = { token: 'aZ0-_abc', expiresAt: 1 };

test('isSetupTokenResponse accepts a real mint', () => {
  assert.equal(isSetupTokenResponse(MINT), true);
  // Additive fields are fine: an older Burrow reading a newer Relay still works.
  assert.equal(isSetupTokenResponse({ ...MINT, extra: true }), true);
  // A real token is base64url of 32 bytes, comfortably inside the bound.
  assert.equal(isSetupTokenResponse({ ...MINT, token: 'a'.repeat(128) }), true);
});

test('isSetupTokenResponse no longer demands a mint handle', () => {
  // Redemption at the Relay flips nothing on the Burrow any more — the
  // invitation the same QR carries is Burrow memory, and its state is what the
  // panel renders — so `mintId` is gone from the response and from the guard. A
  // Relay that still sends one is accepted as any other additive field.
  assert.equal(isSetupTokenResponse({ token: 'aZ0-_abc', expiresAt: 1 }), true);
  assert.equal(isSetupTokenResponse({ ...MINT, mintId: 'mint-1' }), true);
  assert.equal(isSetupTokenResponse({ ...MINT, mintId: 42 }), true);
});

test('isSetupTokenResponse rejects a 200 that is not one', () => {
  // The Burrow puts the token straight into a QR encoder and `expiresAt` straight
  // into a `setTimeout` delay, so a missing, mistyped, oversized, or
  // out-of-charset field has to fail the exchange rather than reach either.
  for (const body of [
    null,
    'nope',
    {},
    { token: 'abc' },
    { expiresAt: 1 },
    { ...MINT, token: '' },
    { ...MINT, token: 42 },
    // An oversized token throws inside the QR encoder, under the app-wide
    // ErrorBoundary, which takes every terminal down with it.
    { ...MINT, token: 'a'.repeat(129) },
    { ...MINT, token: 'has spaces' },
    { ...MINT, token: 'not/base64url+' },
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

// --- Routes ----------------------------------------------------------------

test('the route table carries the E2E surface and nothing it replaced', () => {
  // The push challenge and the device-key-parameterized subscription list are
  // deleted: possession of a 256-bit `deliveryId` is the whole proof now, so
  // there is no challenge to sign and no identity to enumerate by.
  assert.equal(API_ROUTES.pushChallenge, undefined);
  assert.equal(API_ROUTES.pushSubscriptions, undefined);
  assert.equal(API_ROUTES.setupRetire, '/api/setup/retire');
  assert.equal(API_ROUTES.reauthBegin, '/api/reauth/begin');
  assert.equal(API_ROUTES.reauthFinish, '/api/reauth/finish');
  assert.equal(API_ROUTES.pushSubscriptionsQuery, '/api/push/subscriptions/query');
  assert.equal(API_ROUTES.pushSubscriptionDelete, '/api/push/subscriptions/:deliveryId');
});

test('pushSubscriptionDeletePath fills the route pattern the Relay registers', () => {
  // One builder, so the Relay's registration and the client's fetch cannot
  // spell the parameter differently.
  const deliveryId = 'aZ0-_'.repeat(9).slice(0, 43);
  assert.equal(
    pushSubscriptionDeletePath(deliveryId),
    API_ROUTES.pushSubscriptionDelete.replace(':deliveryId', deliveryId),
  );
  // base64url is entirely unreserved, so a real id survives verbatim.
  assert.equal(pushSubscriptionDeletePath(deliveryId).endsWith(deliveryId), true);
});

test('pushSubscriptionDeletePath encodes an id that would otherwise be a path', () => {
  // The id is a bearer capability rather than an enumerable identifier, so it
  // rides the path; encoding here — not at each caller — is what stops a
  // hostile value from naming a different route.
  assert.equal(pushSubscriptionDeletePath('../devices'), '/api/push/subscriptions/..%2Fdevices');
  assert.equal(pushSubscriptionDeletePath('a b'), '/api/push/subscriptions/a%20b');
  assert.equal(pushSubscriptionDeletePath(''), '/api/push/subscriptions/');
});

test('a subscriptions query is bounded, so the route is not a bulk oracle', () => {
  // A browser holds one delivery id per paired Burrow; the cap is far above any
  // real use and is what keeps the readback from being an enumeration.
  assert.equal(MAX_PUSH_QUERY_DELIVERY_IDS, 64);
});

// --- The `e2e` relay envelope ---------------------------------------------

const E2E_CLIENT = {
  t: 'e2e',
  burrowId: 'AAAAAAAAAAAAAAAAAAAAAA',
  kind: 'connection',
  id: 'BBBBBBBBBBBBBBBBBBBBBB',
  step: 'init',
  ct: 'Zm9v',
};
const E2E_BURROW = {
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
    { ...E2E_CLIENT, burrowId: 'short' },
    { ...E2E_CLIENT, kind: 'terminal' },
    { ...E2E_CLIENT, id: 'short' },
    // `response` is the Burrow's step; a Client claiming it is not this frame.
    { ...E2E_CLIENT, step: 'response' },
    { ...E2E_CLIENT, step: 'init2' },
    { ...E2E_CLIENT, ct: 'a'.repeat(MAX_E2E_CIPHERTEXT_LENGTH + 1) },
    { ...E2E_CLIENT, ct: '' },
  ]) {
    assert.equal(isE2eClientFrame(frame), false, JSON.stringify(frame));
  }
});

test('isE2eRelayToBurrowFrame additionally proves the relay-stamped clientId', () => {
  assert.equal(isE2eRelayToBurrowFrame(E2E_CLIENT), false, 'no clientId');
  assert.equal(isE2eRelayToBurrowFrame({ ...E2E_CLIENT, clientId: 'c-1' }), true);
  assert.equal(
    isE2eRelayToBurrowFrame({ ...E2E_CLIENT, clientId: 'c'.repeat(MAX_CLIENT_ID_LENGTH + 1) }),
    false,
    'the id is a map key on a path the model does not trust',
  );
});

test('isE2eBurrowFrame takes the burrow steps and no burrowId', () => {
  assert.equal(isE2eBurrowFrame(E2E_BURROW), true);
  assert.equal(isE2eBurrowFrame({ ...E2E_BURROW, step: 'transport' }), true);
  for (const frame of [
    { ...E2E_BURROW, step: 'init' },
    { ...E2E_BURROW, clientId: 42 },
    { ...E2E_BURROW, kind: 'nope' },
    { ...E2E_BURROW, id: 'short' },
    { ...E2E_BURROW, ct: 'has spaces' },
  ]) {
    assert.equal(isE2eBurrowFrame(frame), false, JSON.stringify(frame));
  }
});

test('isE2eRelayToClientFrame takes the burrow steps with a stamped burrowId', () => {
  // The mirror of the Burrow's guard: the relay stamps `burrowId` on the way out,
  // and the Client trusts the relay no further than the Burrow does.
  const stamped = { t: 'e2e', burrowId: E2E_CLIENT.burrowId, kind: 'connection', id: E2E_CLIENT.id, step: 'response', ct: E2E_CLIENT.ct };
  assert.equal(isE2eRelayToClientFrame(stamped), true);
  assert.equal(isE2eRelayToClientFrame({ ...stamped, step: 'transport' }), true);
  for (const frame of [
    null,
    'nope',
    { ...stamped, t: 'msg' },
    // `init` is the Client's own step; the relay never sends one back.
    { ...stamped, step: 'init' },
    { ...stamped, burrowId: 'short' },
    { ...stamped, kind: 'terminal' },
    { ...stamped, id: 'short' },
    { ...stamped, ct: '' },
    { ...stamped, ct: 'a'.repeat(MAX_E2E_CIPHERTEXT_LENGTH + 1) },
  ]) {
    assert.equal(isE2eRelayToClientFrame(frame), false, JSON.stringify(frame));
  }
});

// --- Hosted's device-code enrollment ---------------------------------------

const userCode = '23AB-YZ9K';

test('the user code alphabet is thirty characters no one misreads, and only those', () => {
  assert.equal(ENROLL_USER_CODE_ALPHABET.length, 30);
  assert.equal(new Set(ENROLL_USER_CODE_ALPHABET).size, 30);
  for (const misread of '01OILU') assert.ok(!ENROLL_USER_CODE_ALPHABET.includes(misread), misread);
  for (let code = 0; code < 128; code += 1) {
    const char = String.fromCharCode(code);
    assert.equal(isEnrollUserCode(`${char}AAA-AAAA`), ENROLL_USER_CODE_ALPHABET.includes(char), char);
  }
});

test('normalizeEnrollUserCode forgives case, spaces, and dashes, and nothing else', () => {
  for (const typed of ['23ab-yz9k', ' 23AB YZ9K ', '23ABYZ9K', '23-AB-YZ-9K']) {
    assert.equal(normalizeEnrollUserCode(typed), userCode, typed);
  }
  for (const bad of ['23AB-YZ9', '23AB-YZ9KK', '23AB-YZ0K', 'O3AB-YZ9K', 7, null, `${userCode}${' '.repeat(40)}`]) {
    assert.equal(normalizeEnrollUserCode(bad), null, String(bad));
  }
});

test('enrollUserCode is the HMAC of the device code, five bits a character, past thirty skipped', async () => {
  const secret = 'test-enroll-secret';
  const deviceCode = new Uint8Array(32).map((_, i) => i * 7);
  // An independent reading of the same rule over node's HMAC.
  const bits = [...createHmac('sha256', secret).update(deviceCode).digest()]
    .map((byte) => byte.toString(2).padStart(8, '0'))
    .join('');
  const chars = [];
  for (let at = 0; chars.length < 8; at += 5) {
    const value = parseInt(bits.slice(at, at + 5), 2);
    if (value < 30) chars.push(ENROLL_USER_CODE_ALPHABET[value]);
  }
  const expected = `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
  assert.equal(await enrollUserCode(secret, deviceCode), expected);
  assert.ok(isEnrollUserCode(expected));
  // Another secret, or one changed byte, is another code.
  assert.notEqual(await enrollUserCode(`${secret}x`, deviceCode), expected);
  assert.notEqual(await enrollUserCode(secret, deviceCode.map((byte, i) => (i === 31 ? byte ^ 1 : byte))), expected);

  // 30 and 31 are skipped, never folded onto the first characters.
  const macOf = (groups) => {
    const text = groups.map((value) => value.toString(2).padStart(5, '0')).join('').padEnd(256, '1');
    return Uint8Array.from({ length: 32 }, (_, i) => parseInt(text.slice(i * 8, i * 8 + 8), 2));
  };
  const fake = (mac) => ({ importKey: async () => ({}), sign: async () => mac.buffer });
  assert.equal(
    await enrollUserCode(secret, deviceCode, fake(macOf([30, 0, 31, 29, 1, 2, 3, 4, 5, 6]))),
    '2Z34-5678',
  );
  await assert.rejects(enrollUserCode(secret, deviceCode, fake(macOf([0, 1, 2, 3, 4, 5, 6]))), /No user code/);
});

test('isBurrowEnrollBeginResponse holds each field to its shape and bounds', () => {
  const begin = {
    deviceCode: 'D'.repeat(RELAY_BEARER_LENGTH),
    userCode,
    verificationUrl: `https://hosted.dormouse.sh/enroll#${userCode}`,
    expiresAt: 1_800_000_000_000,
    interval: 5,
  };
  assert.ok(isBurrowEnrollBeginResponse(begin));
  // A deployment naming no account origin sends no verificationUrl.
  const { verificationUrl: _omitted, ...bare } = begin;
  assert.ok(isBurrowEnrollBeginResponse(bare));
  assert.ok(isBurrowEnrollBeginResponse({ ...begin, interval: MIN_ENROLL_POLL_INTERVAL_S }));
  assert.ok(isBurrowEnrollBeginResponse({ ...begin, interval: MAX_ENROLL_POLL_INTERVAL_S }));
  for (const wrong of [
    null,
    'begin',
    { ...begin, deviceCode: undefined },
    { ...begin, deviceCode: 'D'.repeat(RELAY_BEARER_LENGTH - 1) },
    { ...begin, deviceCode: `${'D'.repeat(RELAY_BEARER_LENGTH - 1)}=` },
    { ...begin, userCode: undefined },
    { ...begin, userCode: '23ab-yz9k' },
    { ...begin, userCode: '23ABYZ9K' },
    { ...begin, verificationUrl: 7 },
    { ...begin, verificationUrl: `https://hosted.dormouse.sh/enroll#${'x'.repeat(512)}` },
    { ...begin, expiresAt: undefined },
    { ...begin, expiresAt: '1800000000000' },
    { ...begin, expiresAt: Number.POSITIVE_INFINITY },
    { ...begin, expiresAt: 0 },
    { ...begin, interval: undefined },
    { ...begin, interval: '5' },
    { ...begin, interval: 2.5 },
    { ...begin, interval: MIN_ENROLL_POLL_INTERVAL_S - 1 },
    { ...begin, interval: MAX_ENROLL_POLL_INTERVAL_S + 1 },
  ]) {
    assert.equal(isBurrowEnrollBeginResponse(wrong), false, JSON.stringify(wrong));
  }
});

test('isBurrowEnrollPollResponse knows four answers, a redeemed one naming its Burrow', () => {
  const burrowId = 'A'.repeat(22);
  assert.ok(isBurrowEnrollPollResponse({ status: 'pending' }));
  assert.ok(isBurrowEnrollPollResponse({ status: 'expired' }));
  assert.ok(isBurrowEnrollPollResponse({ status: 'redeemed', burrowId }));
  assert.ok(isBurrowEnrollPollResponse({ status: 'enrolled', enrollment: {} }));
  for (const wrong of [
    null,
    'pending',
    { status: 'redeemed' },
    { status: 'redeemed', burrowId: 'short' },
    { status: 'redeemed', burrowId: 7 },
    { status: 'enrolled' },
    { status: 'enrolled', enrollment: 'x' },
    { status: 'approved' },
  ]) {
    assert.equal(isBurrowEnrollPollResponse(wrong), false, JSON.stringify(wrong));
  }
});
