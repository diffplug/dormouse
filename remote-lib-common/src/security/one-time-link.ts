/**
 * The one-time link and its grammar (`docs/specs/one-time.md` → "Link").
 *
 * A Burrow mints one link per one-time connection, renders it as one URL, and a
 * phone reads it back with {@link parseOneTimeLinkUrl}. Both halves live here
 * for the reason the pairing invitation's do (`pairing-invitation.ts`): the
 * fragment is positional and carries no field names, so a disagreement about
 * order or length would be a silent failed handshake rather than a parse error.
 */

import { base64UrlLength, fromBase64Url, isExactBase64Url } from './bytes.js';
import { isLinkScheme, parseLinkFragment, type LinkUrlShape } from './link-url.js';
import { NOISE_KEY_LENGTH } from './noise.js';
import { e2eOneTimePrologue } from './noise-transport.js';
import { getWebCrypto, type WebCryptoLike } from './webcrypto.js';

/** The E2E wire version the fragment leads with. Any other value is rejected, never negotiated. */
export const ONE_TIME_LINK_VERSION = '1';

/**
 * The path Hosted serves the phone page at, and the one path a link may carry.
 * Owned here rather than beside the rendezvous routes because the link grammar
 * is what a phone checks it against, and `security/` never imports `remote/`.
 */
export const ONE_TIME_PAGE_PATH = '/connect/';

/** The one hash prefix a one-time link may carry: the fragment starts at once. */
const ONE_TIME_HASH_PREFIX = '#';

/** Positional fields are dot-delimited; a field may therefore never contain one. */
const FIELD_SEPARATOR = '.';

/** 16 bytes as 22 characters — the routing-id length the rendezvous frames pin. */
const ROOM_ID_LENGTH = base64UrlLength(16);

/** 32 bytes as 43 characters: the one-use public key. */
const KEY_LENGTH = base64UrlLength(NOISE_KEY_LENGTH);

/** Epoch seconds as exactly this many decimal digits, zero-padded. */
const EXPIRY_DIGITS = 10;

/** The one spelling of an expiry field, built from {@link EXPIRY_DIGITS}. */
const EXPIRY_PATTERN = new RegExp(`^[0-9]{${EXPIRY_DIGITS}}$`);

/** The largest epoch-seconds value a uint32 expiry may carry. */
const MAX_UINT32 = 0xffff_ffff;

/** How many dot-delimited fields the fragment carries. */
const FRAGMENT_FIELD_COUNT = 4;

/**
 * The positional fragment's exact length: every field plus its separators.
 * Fixed, because every field is fixed — a fragment of any other length is
 * rejected before a single field is read.
 */
export const ONE_TIME_FRAGMENT_LENGTH =
  ONE_TIME_LINK_VERSION.length + ROOM_ID_LENGTH + EXPIRY_DIGITS + KEY_LENGTH + (FRAGMENT_FIELD_COUNT - 1);

/**
 * The longest complete link a Burrow will mint and a phone will parse.
 *
 * Enforced *before* any QR encoder runs, for the reason
 * `PAIRING_QR_URL_MAX_LENGTH` is: an encoder throws above its capacity inside
 * the app-wide ErrorBoundary. The origin is the only variable-length part, so
 * this also bounds the origin a link can name.
 */
export const ONE_TIME_LINK_MAX_LENGTH = 256;

/**
 * The longest relay origin a desktop build may bake: everything else in a
 * one-time link is fixed, so a longer origin mints links no phone can scan.
 */
export const MAX_RELAY_ORIGIN_LENGTH =
  ONE_TIME_LINK_MAX_LENGTH - ONE_TIME_PAGE_PATH.length - ONE_TIME_HASH_PREFIX.length - ONE_TIME_FRAGMENT_LENGTH;

/**
 * Whether a desktop build may bake `origin` (`docs/specs/burrow-service.md` → "Relay
 * origin"): a bare origin as `new URL` spells it, on a link scheme
 * ({@link isLinkScheme}), of at most {@link MAX_RELAY_ORIGIN_LENGTH}
 * characters. `scripts/relay-origin.mjs` fails the build on anything else.
 */
export function isAcceptedRelayOrigin(origin: unknown): boolean {
  if (typeof origin !== 'string' || origin.length > MAX_RELAY_ORIGIN_LENGTH) return false;
  try {
    const url = new URL(origin);
    return url.origin === origin && isLinkScheme(url);
  } catch {
    return false;
  }
}

/** Where a one-time link carries its fragment: on the page path, right after `#`. */
const ONE_TIME_LINK_SHAPE: LinkUrlShape = {
  maxLength: ONE_TIME_LINK_MAX_LENGTH,
  pathname: ONE_TIME_PAGE_PATH,
  hashPrefix: ONE_TIME_HASH_PREFIX,
};

/** One link, as the Burrow holds it and the phone reads it back. */
export interface OneTimeLink {
  /** The rendezvous room, base64url of 16 bytes, minted by Hosted. */
  readonly roomId: string;
  /** Epoch **seconds**; the phone's fail-fast, and the Burrow's own attempt check. */
  readonly expiry: number;
  /** The one-use Burrow Noise responder key for this link, raw 32 bytes. */
  readonly ephPub: Uint8Array;
  /** The same key as it appears in the fragment and the prologue. */
  readonly ephPubBase64Url: string;
}

/** Epoch seconds as the fragment spells them: exactly ten digits, zero-padded. */
function formatExpiry(expirySeconds: number): string {
  if (!Number.isInteger(expirySeconds) || expirySeconds < 0 || expirySeconds > MAX_UINT32) {
    throw new Error('one-time link expiry must be a uint32 epoch-seconds value');
  }
  return String(expirySeconds).padStart(EXPIRY_DIGITS, '0');
}

/**
 * The link fields the one-time prologue binds, in the order the link carries
 * them — the version first, then everything but the `roomId`, which
 * {@link e2eOneTimePrologue} binds itself.
 *
 * One builder, so the phone and the Burrow cannot disagree about the transcript.
 */
export function oneTimeLinkFields(link: Pick<OneTimeLink, 'expiry' | 'ephPubBase64Url'>): string[] {
  return [ONE_TIME_LINK_VERSION, formatExpiry(link.expiry), link.ephPubBase64Url];
}

/** The one-time prologue for one link: the `roomId` plus every field above. */
export function oneTimeLinkPrologue(
  link: Pick<OneTimeLink, 'roomId' | 'expiry' | 'ephPubBase64Url'>,
): Uint8Array {
  return e2eOneTimePrologue(link.roomId, oneTimeLinkFields(link));
}

/**
 * Whether a link is past its expiry at `nowMs`. The expiry second itself is
 * still live, and the parser refuses on exactly this rule.
 */
export function oneTimeLinkExpired(link: Pick<OneTimeLink, 'expiry'>, nowMs: number): boolean {
  return link.expiry * 1000 < nowMs;
}

/**
 * Compose the URL a Burrow shows as its QR and copyable link.
 *
 * **Throws over {@link ONE_TIME_LINK_MAX_LENGTH}, before any encoder runs.**
 */
export function formatOneTimeLinkUrl(origin: string, link: OneTimeLink): string {
  // Through {@link oneTimeLinkFields}, so the fragment and the prologue cannot
  // disagree about order: the version leads, the `roomId` follows it, and the
  // rest is exactly what the transcript binds.
  const [version, ...rest] = oneTimeLinkFields(link);
  const fragment = [version, link.roomId, ...rest].join(FIELD_SEPARATOR);
  const url = `${origin}${ONE_TIME_PAGE_PATH}${ONE_TIME_HASH_PREFIX}${fragment}`;
  if (url.length > ONE_TIME_LINK_MAX_LENGTH) {
    throw new Error(
      `one-time link is ${url.length} characters, over the ${ONE_TIME_LINK_MAX_LENGTH} limit; ` +
        'the one-time origin is too long for a scannable code.',
    );
  }
  return url;
}

/**
 * The one boundary an opened, scanned, or pasted one-time link crosses.
 *
 * **Returns the complete link or `null` — never a partial parse**, with
 * `parsePairingInvitationUrl`'s discipline: the length cap precedes URL
 * parsing, the structural checks precede the per-field alphabets, the expiry
 * precedes the key, and the X25519 import runs last. The URL around the
 * fragment is {@link parseLinkFragment}'s, `appOrigin` compared exactly.
 *
 * A caller that must tell an expired link from a wrong one parses at `now = 0`
 * and asks {@link oneTimeLinkExpired}.
 */
export async function parseOneTimeLinkUrl(
  text: unknown,
  appOrigin: string,
  now: number = Date.now(),
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<OneTimeLink | null> {
  const fragment = parseLinkFragment(text, appOrigin, ONE_TIME_LINK_SHAPE);
  if (fragment === null || fragment.length !== ONE_TIME_FRAGMENT_LENGTH) return null;
  const fields = fragment.split(FIELD_SEPARATOR);
  if (fields.length !== FRAGMENT_FIELD_COUNT) return null;
  const [version, roomId, expiryText, ephPubBase64Url] = fields as [string, string, string, string];
  if (version !== ONE_TIME_LINK_VERSION) return null;
  if (!isExactBase64Url(roomId, ROOM_ID_LENGTH) || !isExactBase64Url(ephPubBase64Url, KEY_LENGTH)) return null;
  if (!EXPIRY_PATTERN.test(expiryText)) return null;
  const expiry = Number(expiryText);
  if (expiry > MAX_UINT32) return null;
  // Advisory on the phone — the Burrow checks its own copy at the attempt — but
  // a dead link should fail here rather than after the Connect tap.
  if (oneTimeLinkExpired({ expiry }, now)) return null;

  let ephPub: Uint8Array;
  try {
    ephPub = fromBase64Url(ephPubBase64Url);
  } catch {
    return null;
  }
  if (ephPub.length !== NOISE_KEY_LENGTH) return null;
  try {
    // The last check, and the only expensive one: a key the suite cannot import
    // is a link no handshake could ever use.
    await crypto.subtle.importKey('raw', ephPub, { name: 'X25519' }, true, []);
  } catch {
    return null;
  }
  return { roomId, expiry, ephPub, ephPubBase64Url };
}
