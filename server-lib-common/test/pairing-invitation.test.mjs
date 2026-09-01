/**
 * The QR grammar and its one parser (docs/specs/server.md -> `## Future` -> QR
 * grammar, Parser).
 *
 * The fragment is positional and carries no field names, so the emitter and the
 * parser disagreeing about order or length would be a silent mis-pairing rather
 * than a parse error. Everything here is therefore pinned against hand-written
 * vectors rather than against the code that produced them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PAIRING_FRAGMENT_LENGTH,
  PAIRING_HASH_PREFIX,
  PAIRING_INVITATION_VERSION,
  PAIRING_QR_URL_MAX_LENGTH,
  e2ePairingPrologue,
  formatInvitationExpiry,
  formatPairingInvitationUrl,
  fromBase64Url,
  pairingInvitationFields,
  pairingInvitationPrologue,
  parsePairingInvitationUrl,
} from '../dist/index.js';

const ORIGIN = 'https://pocket.example';

/** 16 bytes 0x00..0x0f, 16 bytes 0xf0..0xe1, 32 bytes 0x80.., 32 bytes 0x00.. */
const HOST_ID = 'AAECAwQFBgcICQoLDA0ODw';
const INVITE_ID = '8O_u7ezr6uno5-bl5OPi4Q';
const SETUP_TOKEN = 'gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp8';
const EPH_PUB = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const EXPIRY = 1_700_000_300;

/** Epoch ms comfortably inside the invitation's advisory life. */
const NOW = 1_700_000_000_000;

const INVITATION = {
  hostId: HOST_ID,
  inviteId: INVITE_ID,
  expiry: EXPIRY,
  setupToken: SETUP_TOKEN,
  ephPub: fromBase64Url(EPH_PUB),
  ephPubBase64Url: EPH_PUB,
};

/** The exact URL a Host with this origin and this invitation must render. */
const EXPECTED_URL =
  'https://pocket.example/#pair?1.AAECAwQFBgcICQoLDA0ODw.8O_u7ezr6uno5-bl5OPi4Q.1700000300' +
  '.gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp8.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

/** The fragment of {@link EXPECTED_URL}, for building one-field mutations. */
const FIELDS = EXPECTED_URL.slice(EXPECTED_URL.indexOf(PAIRING_HASH_PREFIX) + PAIRING_HASH_PREFIX.length).split('.');

/** `EXPECTED_URL` with one positional field replaced. */
function urlWithField(index, value) {
  const fields = [...FIELDS];
  fields[index] = value;
  return `${ORIGIN}/${PAIRING_HASH_PREFIX}${fields.join('.')}`;
}

// --- Exact vectors ---------------------------------------------------------

test('one invitation renders exactly one URL', () => {
  assert.equal(formatPairingInvitationUrl(ORIGIN, INVITATION), EXPECTED_URL);
});

test('the fragment is exactly 146 characters of six positional fields', () => {
  const fragment = EXPECTED_URL.slice(
    EXPECTED_URL.indexOf(PAIRING_HASH_PREFIX) + PAIRING_HASH_PREFIX.length,
  );
  assert.equal(fragment.length, 146);
  assert.equal(fragment.length, PAIRING_FRAGMENT_LENGTH);
  const [version, hostId, inviteId, expiry, setupToken, ephPub] = fragment.split('.');
  assert.equal(version, PAIRING_INVITATION_VERSION);
  assert.equal(hostId.length, 22);
  assert.equal(inviteId.length, 22);
  assert.equal(expiry, '1700000300');
  assert.equal(setupToken.length, 43);
  assert.equal(ephPub.length, 43);
});

test('a minted URL parses back to the same invitation', async () => {
  const parsed = await parsePairingInvitationUrl(EXPECTED_URL, ORIGIN, NOW);
  assert.ok(parsed);
  assert.equal(parsed.hostId, HOST_ID);
  assert.equal(parsed.inviteId, INVITE_ID);
  assert.equal(parsed.expiry, EXPIRY);
  assert.equal(parsed.setupToken, SETUP_TOKEN);
  assert.equal(parsed.ephPubBase64Url, EPH_PUB);
  assert.deepEqual(parsed.ephPub, INVITATION.ephPub);
  // Round trip: what the parser returns re-renders the same URL, which is the
  // whole of "the emitter and the parser cannot drift".
  assert.equal(formatPairingInvitationUrl(ORIGIN, parsed), EXPECTED_URL);
});

test('the expiry is exactly ten zero-padded digits', () => {
  assert.equal(formatInvitationExpiry(EXPIRY), '1700000300');
  assert.equal(formatInvitationExpiry(0), '0000000000');
  assert.equal(formatInvitationExpiry(0xffff_ffff), '4294967295');
  for (const bad of [-1, 1.5, 0x1_0000_0000, Number.NaN]) {
    assert.throws(() => formatInvitationExpiry(bad), /uint32 epoch-seconds/);
  }
});

test('the prologue binds every invitation field but the hostId, in QR order', () => {
  // `e2ePairingPrologue` already binds the hostId, so repeating it would be
  // two spellings of one fact. A disagreement here surfaces as a decrypt
  // failure at message 1 and reads like a bug in the suite, which is why one
  // builder serves both sides.
  assert.deepEqual(pairingInvitationFields(INVITATION), [
    PAIRING_INVITATION_VERSION,
    INVITE_ID,
    '1700000300',
    SETUP_TOKEN,
    EPH_PUB,
  ]);
  assert.deepEqual(
    pairingInvitationPrologue(INVITATION),
    e2ePairingPrologue(HOST_ID, pairingInvitationFields(INVITATION)),
  );
});

// --- The origin bound ------------------------------------------------------

/**
 * The longest origin a self-hoster may serve Pocket from: the URL cap less the
 * fixed `/` + `#pair?` + 146-character tail.
 */
const MAX_ORIGIN_LENGTH = PAIRING_QR_URL_MAX_LENGTH - 1 - PAIRING_HASH_PREFIX.length - PAIRING_FRAGMENT_LENGTH;

/** A real origin of exactly `length` characters, with DNS-legal labels. */
function originOfLength(length) {
  const host = length - 'https://'.length - '.dev'.length;
  const first = Math.min(host, 63);
  const rest = host - first - 1;
  return `https://${'a'.repeat(first)}${rest >= 0 ? `.${'b'.repeat(rest)}` : ''}.dev`;
}

test('the longest accepted origin still mints and parses', async () => {
  assert.equal(MAX_ORIGIN_LENGTH, 103);
  const origin = originOfLength(MAX_ORIGIN_LENGTH);
  assert.equal(origin.length, MAX_ORIGIN_LENGTH);
  const url = formatPairingInvitationUrl(origin, INVITATION);
  assert.equal(url.length, PAIRING_QR_URL_MAX_LENGTH);
  assert.equal(new URL(url).origin, origin, 'the test origin must be one a URL normalizes to itself');
  assert.ok(await parsePairingInvitationUrl(url, origin, NOW));
});

test('one character more is refused at mint time, before any encoder runs', async () => {
  // A QR encoder throws above its capacity — inside the app-wide ErrorBoundary,
  // taking every terminal down with it — so the failure has to be "this
  // deployment's origin is too long", raised where a human can read it.
  const origin = originOfLength(MAX_ORIGIN_LENGTH + 1);
  assert.throws(() => formatPairingInvitationUrl(origin, INVITATION), /257 characters/);
  // And the parser refuses the same string, on a length compare rather than a
  // URL parse: a megabyte of camera text must not cost one.
  const overLong = `${origin}/${PAIRING_HASH_PREFIX}${FIELDS.join('.')}`;
  assert.equal(overLong.length, PAIRING_QR_URL_MAX_LENGTH + 1);
  assert.equal(await parsePairingInvitationUrl(overLong, origin, NOW), null);
  assert.equal(await parsePairingInvitationUrl('x'.repeat(1_000_000), ORIGIN, NOW), null);
});

// --- One rejection per parser rule ----------------------------------------

test('the parser refuses anything that is not a string', async () => {
  for (const value of [undefined, null, 42, {}, ['https://pocket.example/'], new URL(EXPECTED_URL)]) {
    assert.equal(await parsePairingInvitationUrl(value, ORIGIN, NOW), null);
  }
});

test('the parser refuses a URL that is not this app, served over HTTPS, at the root', async () => {
  for (const [why, text] of [
    ['not a URL at all', `pocket.example/${PAIRING_HASH_PREFIX}${FIELDS.join('.')}`],
    // A fragment is invisible to the Server, so the origin compare is the only
    // thing that stops a code bootstrapping a different deployment's Pocket.
    ['plain http', `http://pocket.example/${PAIRING_HASH_PREFIX}${FIELDS.join('.')}`],
    // Credentials would let a code name an origin the compare accepts while the
    // browser navigates somewhere else entirely.
    ['credentials in the authority', `https://evil@pocket.example/${PAIRING_HASH_PREFIX}${FIELDS.join('.')}`],
    ['a password too', `https://a:b@pocket.example/${PAIRING_HASH_PREFIX}${FIELDS.join('.')}`],
    ['a non-root path', `${ORIGIN}/app/${PAIRING_HASH_PREFIX}${FIELDS.join('.')}`],
    ['a query string', `${ORIGIN}/?next=x${PAIRING_HASH_PREFIX}${FIELDS.join('.')}`],
    ['a different origin', `https://pocket.evil/${PAIRING_HASH_PREFIX}${FIELDS.join('.')}`],
    ['a different port', `https://pocket.example:8443/${PAIRING_HASH_PREFIX}${FIELDS.join('.')}`],
    ['no hash at all', `${ORIGIN}/`],
    ['the wrong hash prefix', `${ORIGIN}/#setup?${FIELDS.join('.')}`],
    ['a hash that merely contains the prefix', `${ORIGIN}/#x${PAIRING_HASH_PREFIX}${FIELDS.join('.')}`],
  ]) {
    assert.equal(await parsePairingInvitationUrl(text, ORIGIN, NOW), null, why);
  }
});

test('the fragment is six fields, no more and no fewer', async () => {
  // Both counts are built at exactly 146 characters, so the length check
  // passes and the field count is what refuses them. Five: the last separator
  // is spent as a base64url character, merging the token and the key. Seven:
  // one is spent splitting the token in half.
  const five = [...FIELDS.slice(0, 4), `${SETUP_TOKEN}A${EPH_PUB}`];
  const seven = [...FIELDS.slice(0, 4), SETUP_TOKEN.slice(0, 21), SETUP_TOKEN.slice(22), EPH_PUB];
  for (const fields of [five, seven]) {
    const url = `${ORIGIN}/${PAIRING_HASH_PREFIX}${fields.join('.')}`;
    assert.equal(url.length, EXPECTED_URL.length);
    assert.equal(await parsePairingInvitationUrl(url, ORIGIN, NOW), null, `${fields.length} fields`);
  }
  // And the ordinary short and long fragments, refused on length.
  assert.equal(
    await parsePairingInvitationUrl(
      `${ORIGIN}/${PAIRING_HASH_PREFIX}${FIELDS.slice(0, 5).join('.')}`,
      ORIGIN,
      NOW,
    ),
    null,
  );
  assert.equal(
    await parsePairingInvitationUrl(`${EXPECTED_URL}.x`, ORIGIN, NOW),
    null,
  );
});

test('the version is a literal, never negotiated', async () => {
  for (const version of ['2', '0', 'v']) {
    assert.equal(await parsePairingInvitationUrl(urlWithField(0, version), ORIGIN, NOW), null);
  }
});

test('every field is canonical base64url at its exact length', async () => {
  // Same length, one character outside the alphabet. Padding is refused even
  // though the decoder tolerates it, so a byte string has one spelling here.
  for (const [why, index, value] of [
    ['a padded hostId', 1, `${HOST_ID.slice(0, 21)}=`],
    ['a base64 (not base64url) inviteId', 2, `${INVITE_ID.slice(0, 21)}+`],
    ['a setup token with a slash', 4, `${SETUP_TOKEN.slice(0, 42)}/`],
    ['an invitation key with a tilde', 5, `${EPH_PUB.slice(0, 42)}~`],
  ]) {
    assert.equal(await parsePairingInvitationUrl(urlWithField(index, value), ORIGIN, NOW), null, why);
  }

  // A character borrowed from the hostId and given to the inviteId keeps the
  // fragment at 146 and is still refused: each field's length is its own rule,
  // not a consequence of the total.
  const borrowed = [...FIELDS];
  borrowed[1] = HOST_ID.slice(0, 21);
  borrowed[2] = `${INVITE_ID}A`;
  const url = `${ORIGIN}/${PAIRING_HASH_PREFIX}${borrowed.join('.')}`;
  assert.equal(url.length, EXPECTED_URL.length);
  assert.equal(await parsePairingInvitationUrl(url, ORIGIN, NOW), null);
});

test('the expiry is ten decimal digits inside a uint32, and not already past', async () => {
  for (const [why, expiry] of [
    ['non-numeric', '+123456789'],
    ['hex-ish', '17000003ab'],
    // 9 digits makes the fragment 145 characters; borrowing the tenth from
    // another field makes that field the wrong length. There is no spelling.
    ['nine digits', '170000030'],
    ['over uint32', '9999999999'],
  ]) {
    assert.equal(await parsePairingInvitationUrl(urlWithField(3, expiry), ORIGIN, NOW), null, why);
  }
  // Advisory only — the Host's memory stays authoritative — but a code that is
  // already dead should fail here rather than after a handshake.
  assert.equal(await parsePairingInvitationUrl(EXPECTED_URL, ORIGIN, EXPIRY * 1000 + 1), null);
  assert.ok(await parsePairingInvitationUrl(EXPECTED_URL, ORIGIN, EXPIRY * 1000));
});

test('the invitation key must decode canonically and import as X25519', async () => {
  // 43 characters always decode to 32 bytes, so the only decode failure left is
  // a final character carrying nonzero trailing bits — one spelling per key.
  assert.equal(fromBase64Url(EPH_PUB).length, 32);
  assert.throws(() => fromBase64Url(`${EPH_PUB.slice(0, 42)}a`), /trailing bits/);
  assert.equal(
    await parsePairingInvitationUrl(urlWithField(5, `${EPH_PUB.slice(0, 42)}a`), ORIGIN, NOW),
    null,
  );

  // The import itself is the last check and the only expensive one. Node's
  // WebCrypto accepts every 32-byte value as an X25519 public key, so the
  // branch is proven with a suite that refuses the import instead — a runtime
  // that validates points must reject the code rather than throw at handshake.
  const refusing = {
    getRandomValues: (array) => globalThis.crypto.getRandomValues(array),
    subtle: {
      ...globalThis.crypto.subtle,
      importKey: async () => {
        throw new Error('unsupported point');
      },
    },
  };
  assert.equal(await parsePairingInvitationUrl(EXPECTED_URL, ORIGIN, NOW, refusing), null);
});
