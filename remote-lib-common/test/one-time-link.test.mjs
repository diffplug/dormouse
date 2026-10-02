/**
 * The one-time link grammar, its one parser, and the prologue it binds
 * (docs/specs/one-time.md -> Link).
 *
 * The fragment is positional and carries no field names, so the emitter and the
 * parser disagreeing about order or length would be a handshake that silently
 * fails. Everything here is pinned against hand-written vectors rather than
 * against the code that produced them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  E2E_PROLOGUE_DOMAIN,
  MAX_RELAY_ORIGIN_LENGTH,
  ONE_TIME_FRAGMENT_LENGTH,
  ONE_TIME_LINK_MAX_LENGTH,
  ONE_TIME_LINK_VERSION,
  ONE_TIME_PAGE_PATH,
  e2eConnectionPrologue,
  e2eOneTimePrologue,
  e2ePairingPrologue,
  formatOneTimeLinkUrl,
  fromBase64Url,
  isAcceptedRelayOrigin,
  lengthPrefixedConcat,
  oneTimeLinkExpired,
  oneTimeLinkFields,
  oneTimeLinkPrologue,
  parseOneTimeLinkUrl,
  utf8Encode,
} from '../dist/index.js';

const ORIGIN = 'https://hosted.example';

/** 16 bytes 0x00..0x0f, and 32 bytes 0x00..0x1f. */
const ROOM_ID = 'AAECAwQFBgcICQoLDA0ODw';
const EPH_PUB = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const EXPIRY = 1_700_000_300;

/** Epoch ms comfortably inside the link's life. */
const NOW = 1_700_000_000_000;

const LINK = {
  roomId: ROOM_ID,
  expiry: EXPIRY,
  ephPub: fromBase64Url(EPH_PUB),
  ephPubBase64Url: EPH_PUB,
};

/** The exact URL a Burrow with this origin and this link must render. */
const EXPECTED_URL =
  'https://hosted.example/connect/#1.AAECAwQFBgcICQoLDA0ODw.1700000300.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

/** The fragment of {@link EXPECTED_URL}, for building one-field mutations. */
const FIELDS = EXPECTED_URL.slice(EXPECTED_URL.indexOf('#') + 1).split('.');

/** A URL on this origin's page carrying `fields` as its fragment. */
const urlOf = (fields, origin = ORIGIN) => `${origin}/connect/#${fields.join('.')}`;

/** `EXPECTED_URL` with one positional field replaced. */
function urlWithField(index, value) {
  const fields = [...FIELDS];
  fields[index] = value;
  return urlOf(fields);
}

/** A suite whose X25519 import refuses every key. */
const refusing = {
  getRandomValues: (array) => globalThis.crypto.getRandomValues(array),
  subtle: {
    ...globalThis.crypto.subtle,
    importKey: async () => {
      throw new Error('unsupported point');
    },
  },
};

// --- Exact vectors ---------------------------------------------------------

test('one link renders exactly one URL', () => {
  assert.equal(formatOneTimeLinkUrl(ORIGIN, LINK), EXPECTED_URL);
  assert.equal(new URL(EXPECTED_URL).pathname, ONE_TIME_PAGE_PATH);
  assert.equal(ONE_TIME_PAGE_PATH, '/connect/');
});

test('the fragment is exactly 79 characters of four positional fields', () => {
  const fragment = EXPECTED_URL.slice(EXPECTED_URL.indexOf('#') + 1);
  assert.equal(fragment.length, 79);
  assert.equal(fragment.length, ONE_TIME_FRAGMENT_LENGTH);
  const [version, roomId, expiry, ephPub] = fragment.split('.');
  assert.equal(version, ONE_TIME_LINK_VERSION);
  assert.equal(version, '1');
  assert.equal(roomId.length, 22);
  assert.equal(expiry, '1700000300');
  assert.equal(ephPub.length, 43);
});

test('a minted URL parses back to the same link', async () => {
  const parsed = await parseOneTimeLinkUrl(EXPECTED_URL, ORIGIN, NOW);
  assert.deepEqual(parsed, LINK);
  // Round trip: the emitter and the parser cannot drift.
  assert.equal(formatOneTimeLinkUrl(ORIGIN, parsed), EXPECTED_URL);
});

test('the expiry is exactly ten zero-padded digits inside a uint32', () => {
  assert.equal(oneTimeLinkFields({ expiry: 0, ephPubBase64Url: EPH_PUB })[1], '0000000000');
  assert.equal(oneTimeLinkFields({ expiry: 0xffff_ffff, ephPubBase64Url: EPH_PUB })[1], '4294967295');
  for (const bad of [-1, 1.5, 0x1_0000_0000, Number.NaN]) {
    assert.throws(() => oneTimeLinkFields({ expiry: bad, ephPubBase64Url: EPH_PUB }), /uint32 epoch-seconds/);
    assert.throws(() => formatOneTimeLinkUrl(ORIGIN, { ...LINK, expiry: bad }), /uint32 epoch-seconds/);
  }
});

// --- The prologue ------------------------------------------------------------

test('the prologue is the domain, the one-time kind, the room id, then v, expiry, and key', () => {
  // Built by hand from the spec's field list, never from the code under test.
  assert.deepEqual(oneTimeLinkFields(LINK), ['1', '1700000300', EPH_PUB]);
  const expected = lengthPrefixedConcat(
    [E2E_PROLOGUE_DOMAIN, 'one-time', ROOM_ID, '1', '1700000300', EPH_PUB].map((f) => utf8Encode(f)),
  );
  assert.equal(E2E_PROLOGUE_DOMAIN, 'dormouse/e2e/v1');
  assert.deepEqual(oneTimeLinkPrologue(LINK), expected);
  assert.deepEqual(e2eOneTimePrologue(ROOM_ID, oneTimeLinkFields(LINK)), expected);
});

test('the prologue binds every link field', () => {
  const base = oneTimeLinkPrologue(LINK);
  for (const [field, changed] of [
    ['roomId', { ...LINK, roomId: `${ROOM_ID.slice(0, 21)}A` }],
    ['expiry', { ...LINK, expiry: EXPIRY + 1 }],
    ['ephPub', { ...LINK, ephPubBase64Url: `${EPH_PUB.slice(0, 42)}A` }],
  ]) {
    assert.notDeepEqual(oneTimeLinkPrologue(changed), base, field);
  }
  // The version is a field of its own, not implied by the domain.
  assert.notDeepEqual(e2eOneTimePrologue(ROOM_ID, ['2', '1700000300', EPH_PUB]), base);
});

test('a one-time prologue equals no pairing or connection prologue over the same values', () => {
  // Its own kind is what separates the three: a transcript for one ceremony
  // must be useless against the other two, whatever the fields hold.
  const fields = oneTimeLinkFields(LINK);
  const oneTime = e2eOneTimePrologue(ROOM_ID, fields);
  assert.notDeepEqual(oneTime, e2ePairingPrologue(ROOM_ID, fields));
  assert.notDeepEqual(oneTime, e2eConnectionPrologue(ROOM_ID, fields.join('.')));
  assert.notDeepEqual(e2eOneTimePrologue(ROOM_ID, ['x']), e2eConnectionPrologue(ROOM_ID, 'x'));
  assert.notDeepEqual(e2eOneTimePrologue(ROOM_ID, ['x']), e2ePairingPrologue(ROOM_ID, ['x']));
});

// --- Expiry ------------------------------------------------------------------

test('a link is live through its expiry second and dead one millisecond after', async () => {
  assert.equal(oneTimeLinkExpired(LINK, EXPIRY * 1000), false);
  assert.equal(oneTimeLinkExpired(LINK, EXPIRY * 1000 + 1), true);
  assert.equal(oneTimeLinkExpired(LINK, NOW), false);
  // The parser refuses on exactly the same rule.
  assert.ok(await parseOneTimeLinkUrl(EXPECTED_URL, ORIGIN, EXPIRY * 1000));
  assert.equal(await parseOneTimeLinkUrl(EXPECTED_URL, ORIGIN, EXPIRY * 1000 + 1), null);
  // Parsed at the epoch, a dead link is still a link, which is how a caller
  // tells "expired" from "not a link".
  const dead = await parseOneTimeLinkUrl(EXPECTED_URL, ORIGIN, 0);
  assert.equal(oneTimeLinkExpired(dead, EXPIRY * 1000 + 1), true);
});

// --- The length cap --------------------------------------------------------

/** The longest origin a link can name: the cap less `/connect/#` and the fragment. */

/** A real origin of about `length` characters, in DNS-legal labels; callers assert the length. */
function originOfLength(length) {
  const labels = [];
  for (let left = length - 'https://'.length - '.dev'.length; left > 0; left -= 64) {
    labels.push('a'.repeat(Math.min(left, 63)));
  }
  return `https://${labels.join('.')}.dev`;
}

test('the longest accepted origin still mints and parses', async () => {
  assert.equal(ONE_TIME_LINK_MAX_LENGTH, 256);
  assert.equal(MAX_RELAY_ORIGIN_LENGTH, 167);
  const origin = originOfLength(MAX_RELAY_ORIGIN_LENGTH);
  assert.equal(origin.length, MAX_RELAY_ORIGIN_LENGTH);
  assert.equal(new URL(origin).origin, origin, 'the test origin must be one a URL normalizes to itself');
  const url = formatOneTimeLinkUrl(origin, LINK);
  assert.equal(url.length, ONE_TIME_LINK_MAX_LENGTH);
  assert.ok(await parseOneTimeLinkUrl(url, origin, NOW));
});

test('one character more is refused at mint time and by the parser', async () => {
  const origin = originOfLength(MAX_RELAY_ORIGIN_LENGTH + 1);
  assert.equal(origin.length, MAX_RELAY_ORIGIN_LENGTH + 1);
  assert.throws(() => formatOneTimeLinkUrl(origin, LINK), /257 characters/);
  const overLong = urlOf(FIELDS, origin);
  assert.equal(overLong.length, ONE_TIME_LINK_MAX_LENGTH + 1);
  assert.equal(await parseOneTimeLinkUrl(overLong, origin, NOW), null);
  assert.equal(await parseOneTimeLinkUrl('x'.repeat(1_000_000), ORIGIN, NOW), null);
});

test('a build bakes only a bare link-scheme origin that fits a link', () => {
  for (const origin of [
    'https://relay.dormouse.sh',
    'https://relay.dormouse.sh:8443',
    'http://localhost:3000',
    'http://127.0.0.1:8787',
    'http://[::1]:8787',
    originOfLength(MAX_RELAY_ORIGIN_LENGTH),
  ]) {
    assert.equal(isAcceptedRelayOrigin(origin), true, origin);
  }
  for (const origin of [
    'https://relay.dormouse.sh/',
    'https://relay.dormouse.sh/connect',
    'https://user@relay.dormouse.sh',
    'https://relay.dormouse.sh?x=1',
    'HTTPS://relay.dormouse.sh',
    'http://relay.dormouse.sh',
    'http://127.0.0.2:8787',
    'wss://relay.dormouse.sh',
    'relay.dormouse.sh',
    '',
    undefined,
    originOfLength(MAX_RELAY_ORIGIN_LENGTH + 1),
  ]) {
    assert.equal(isAcceptedRelayOrigin(origin), false, String(origin));
  }
});

// --- One rejection per parser rule ----------------------------------------

test('the parser refuses anything that is not a string', async () => {
  for (const value of [undefined, null, 42, {}, [EXPECTED_URL], new URL(EXPECTED_URL)]) {
    assert.equal(await parseOneTimeLinkUrl(value, ORIGIN, NOW), null);
  }
});

test('the parser refuses a URL that is not this app, over HTTPS, on the page path', async () => {
  const fragment = FIELDS.join('.');
  for (const [why, text] of [
    ['not a URL at all', `hosted.example/connect/#${fragment}`],
    ['plain http', `http://hosted.example/connect/#${fragment}`],
    ['credentials in the authority', `https://evil@hosted.example/connect/#${fragment}`],
    ['a password too', `https://a:b@hosted.example/connect/#${fragment}`],
    ['the root path', `${ORIGIN}/#${fragment}`],
    ['no trailing slash', `${ORIGIN}/connect#${fragment}`],
    ['a deeper path', `${ORIGIN}/connect/x/#${fragment}`],
    ['a query string', `${ORIGIN}/connect/?room=x#${fragment}`],
    ['a different origin', `https://hosted.evil/connect/#${fragment}`],
    ['a different port', `https://hosted.example:8443/connect/#${fragment}`],
    ['no hash at all', `${ORIGIN}/connect/`],
    ['the pairing prefix', `${ORIGIN}/connect/#pair?${fragment}`],
    ['a pairing URL', `${ORIGIN}/#pair?${fragment}`],
  ]) {
    assert.equal(await parseOneTimeLinkUrl(text, ORIGIN, NOW), null, why);
  }
});

test('plain HTTP is accepted on a loopback host, and nowhere else', async () => {
  for (const origin of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
    const parsed = await parseOneTimeLinkUrl(urlOf(FIELDS, origin), origin, NOW);
    assert.equal(parsed?.roomId, ROOM_ID, origin);
  }
  for (const origin of ['http://evil.localhost', 'http://127.0.0.1.evil.example', 'http://hosted.example']) {
    assert.equal(await parseOneTimeLinkUrl(urlOf(FIELDS, origin), origin, NOW), null, origin);
  }
});

test('the fragment is four fields, no more and no fewer', async () => {
  // Both built at exactly 79 characters, so the length check passes them.
  // Three: a separator spent as a base64url character. Five: one spent
  // splitting the key.
  const three = [FIELDS[0], FIELDS[1], `${FIELDS[2]}A${FIELDS[3]}`.slice(0, 54)];
  const five = [FIELDS[0], FIELDS[1], FIELDS[2], EPH_PUB.slice(0, 21), EPH_PUB.slice(22)];
  for (const fields of [three, five]) {
    const url = urlOf(fields);
    assert.equal(url.length, EXPECTED_URL.length, `${fields.length} fields`);
    assert.equal(await parseOneTimeLinkUrl(url, ORIGIN, NOW), null, `${fields.length} fields`);
  }
  // And the ordinary short and long fragments, refused on length.
  assert.equal(await parseOneTimeLinkUrl(urlOf(FIELDS.slice(0, 3)), ORIGIN, NOW), null);
  assert.equal(await parseOneTimeLinkUrl(`${EXPECTED_URL}.x`, ORIGIN, NOW), null);
});

test('the version is a literal, never negotiated', async () => {
  for (const version of ['2', '0', 'v']) {
    assert.equal(await parseOneTimeLinkUrl(urlWithField(0, version), ORIGIN, NOW), null);
  }
});

test('every field is canonical base64url at its exact length', async () => {
  for (const [why, index, value] of [
    ['a padded roomId', 1, `${ROOM_ID.slice(0, 21)}=`],
    ['a base64 (not base64url) roomId', 1, `${ROOM_ID.slice(0, 21)}+`],
    ['a key with a slash', 3, `${EPH_PUB.slice(0, 42)}/`],
    ['a key with a tilde', 3, `${EPH_PUB.slice(0, 42)}~`],
  ]) {
    assert.equal(await parseOneTimeLinkUrl(urlWithField(index, value), ORIGIN, NOW), null, why);
  }
  // A character borrowed from the roomId and given to the key keeps the
  // fragment at 79 and is still refused: each field's length is its own rule.
  const borrowed = [FIELDS[0], ROOM_ID.slice(0, 21), FIELDS[2], `${EPH_PUB}A`];
  assert.equal(urlOf(borrowed).length, EXPECTED_URL.length);
  assert.equal(await parseOneTimeLinkUrl(urlOf(borrowed), ORIGIN, NOW), null);
});

test('the expiry is ten decimal digits inside a uint32', async () => {
  for (const [why, expiry] of [
    ['non-numeric', '+123456789'],
    ['hex-ish', '17000003ab'],
    ['over uint32', '9999999999'],
  ]) {
    assert.equal(await parseOneTimeLinkUrl(urlWithField(2, expiry), ORIGIN, NOW), null, why);
  }
  // Nine digits with the tenth borrowed from the key: the key is then short.
  const nine = [FIELDS[0], FIELDS[1], '170000030', `${EPH_PUB}A`];
  assert.equal(urlOf(nine).length, EXPECTED_URL.length);
  assert.equal(await parseOneTimeLinkUrl(urlOf(nine), ORIGIN, NOW), null);
});

test('the key must decode canonically and import as X25519', async () => {
  // 43 characters always decode to 32 bytes, so the only decode failure left is
  // a final character carrying nonzero trailing bits.
  assert.throws(() => fromBase64Url(`${EPH_PUB.slice(0, 42)}a`), /trailing bits/);
  assert.equal(await parseOneTimeLinkUrl(urlWithField(3, `${EPH_PUB.slice(0, 42)}a`), ORIGIN, NOW), null);
  // The import is the last check; Node accepts every 32-byte value, so the
  // branch is proven with a suite that refuses it.
  assert.equal(await parseOneTimeLinkUrl(EXPECTED_URL, ORIGIN, NOW, refusing), null);
});
