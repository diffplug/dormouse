/**
 * The pairing invitation and its QR grammar (`docs/specs/server.md` → "Setup
 * tokens" → QR grammar).
 *
 * A Host mints an invitation, renders it as one URL, and a phone reads it back
 * with {@link parsePairingInvitationUrl}. Both halves live here so the emitter
 * and the parser cannot drift: the fragment is positional and carries no field
 * names, so a single disagreement about order or length would be a silent
 * mis-pairing rather than a parse error.
 */

import { base64UrlLength, fromBase64Url, isBoundedBase64Url } from './bytes.js';
import { NOISE_KEY_LENGTH } from './noise.js';
import { e2ePairingPrologue } from './noise-transport.js';
import { getWebCrypto, type WebCryptoLike } from './webcrypto.js';

/** The E2E wire version the fragment leads with. Any other value is rejected, never negotiated. */
export const PAIRING_INVITATION_VERSION = '1';

/** The one hash prefix a pairing URL may carry. */
export const PAIRING_HASH_PREFIX = '#pair?';

/** Positional fields are dot-delimited; a field may therefore never contain one. */
const FIELD_SEPARATOR = '.';

/** 16 bytes as 22 characters — the same routing-id length the `e2e` envelope pins. */
const ROUTING_ID_LENGTH = base64UrlLength(16);

/** 32 bytes as 43 characters: the setup token and the invitation public key. */
const SECRET_LENGTH = base64UrlLength(32);

/** Epoch seconds as exactly this many decimal digits, zero-padded. */
const EXPIRY_DIGITS = 10;

/** The largest epoch-seconds value a uint32 expiry may carry. */
const MAX_UINT32 = 0xffff_ffff;

/**
 * The positional fragment's exact length: six fields plus five separators.
 * Fixed, because every field is fixed — a fragment of any other length is
 * rejected before a single field is read.
 */
export const PAIRING_FRAGMENT_LENGTH =
  PAIRING_INVITATION_VERSION.length +
  ROUTING_ID_LENGTH * 2 +
  EXPIRY_DIGITS +
  SECRET_LENGTH * 2 +
  5;

/**
 * The longest complete pairing URL a Host will mint.
 *
 * A QR encoder throws above its capacity — inside the app-wide ErrorBoundary,
 * taking every terminal down with it — so the cap is enforced *before* the
 * encoder runs, and before the parser parses. It also bounds the longest origin
 * a self-hoster may serve Pocket from: {@link PAIRING_QR_URL_MAX_LENGTH} minus
 * the fixed `/#pair?` + fragment tail.
 */
export const PAIRING_QR_URL_MAX_LENGTH = 256;

/** One invitation, as the Host holds it and the Client reads it back. */
export interface PairingInvitation {
  /** The relay destination, base64url of 16 bytes. */
  readonly hostId: string;
  /** Single-use invitation id, base64url of 16 bytes; lives only in Host memory. */
  readonly inviteId: string;
  /** Epoch **seconds**; an advisory Client fail-fast, never the authority. */
  readonly expiry: number;
  /** The Server's single-use setup token, base64url of 32 bytes. */
  readonly setupToken: string;
  /** The one-use Host Noise responder key for this invitation, raw 32 bytes. */
  readonly ephPub: Uint8Array;
  /** The same key as it appears in the fragment and the prologue. */
  readonly ephPubBase64Url: string;
}

/**
 * `new URL`, or `null`. Written as a helper rather than a `let url: URL` so the
 * type is inferred: this package compiles with `"types": []`, where `URL` is a
 * value without a global type name.
 */
function parseUrl(text: string) {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/** Base64url of exactly `length` characters, canonical and unpadded. */
function isExact(value: unknown, length: number): value is string {
  return isBoundedBase64Url(value, length) && value.length === length;
}

/** Epoch seconds as the fragment spells them: exactly ten digits, zero-padded. */
export function formatInvitationExpiry(expirySeconds: number): string {
  if (!Number.isInteger(expirySeconds) || expirySeconds < 0 || expirySeconds > MAX_UINT32) {
    throw new Error('pairing invitation expiry must be a uint32 epoch-seconds value');
  }
  return String(expirySeconds).padStart(EXPIRY_DIGITS, '0');
}

/**
 * The invitation fields the pairing prologue binds, in the order the QR carries
 * them — the version first, then everything but the `hostId`, which
 * {@link e2ePairingPrologue} already binds itself.
 *
 * One builder, so the initiator and the responder cannot disagree about the
 * transcript: a mismatch would surface as a decrypt failure at message 1 and
 * read like a bug in the suite.
 */
export function pairingInvitationFields(
  invitation: Pick<PairingInvitation, 'inviteId' | 'expiry' | 'setupToken' | 'ephPubBase64Url'>,
): string[] {
  return [
    PAIRING_INVITATION_VERSION,
    invitation.inviteId,
    formatInvitationExpiry(invitation.expiry),
    invitation.setupToken,
    invitation.ephPubBase64Url,
  ];
}

/** The pairing prologue for one invitation: the `hostId` plus every field above. */
export function pairingInvitationPrologue(invitation: PairingInvitation): Uint8Array {
  return e2ePairingPrologue(invitation.hostId, pairingInvitationFields(invitation));
}

/**
 * Compose the URL a Host renders as its QR.
 *
 * **Throws over {@link PAIRING_QR_URL_MAX_LENGTH}, before any encoder runs.**
 * The only variable-length part is the origin, so the failure is always "this
 * deployment's origin is too long for a scannable code", which is worth an
 * error at mint time rather than a thrown encoder at paint time.
 */
export function formatPairingInvitationUrl(origin: string, invitation: PairingInvitation): string {
  const fragment = [
    PAIRING_INVITATION_VERSION,
    invitation.hostId,
    invitation.inviteId,
    formatInvitationExpiry(invitation.expiry),
    invitation.setupToken,
    invitation.ephPubBase64Url,
  ].join(FIELD_SEPARATOR);
  const url = `${origin}/${PAIRING_HASH_PREFIX}${fragment}`;
  if (url.length > PAIRING_QR_URL_MAX_LENGTH) {
    throw new Error(
      `pairing URL is ${url.length} characters, over the ${PAIRING_QR_URL_MAX_LENGTH} limit; ` +
        'the origin this Host enrolled against is too long for a scannable code.',
    );
  }
  return url;
}

/**
 * The one boundary a scanned, pasted, or camera-supplied pairing code crosses.
 *
 * **Returns the complete invitation or `null` — never a partial parse.** Every
 * check runs before any field is used, in cost order: the length cap precedes
 * URL parsing, the structural checks precede the per-field alphabets, and the
 * X25519 import (the only asynchronous, and by far the most expensive, step)
 * runs last. Nothing here is an error a caller can distinguish; a code is
 * either usable or it is not.
 *
 * `appOrigin` is the origin the running app is served from, and the URL's must
 * equal it exactly: a fragment is invisible to the Server, so the only thing
 * that keeps a code from bootstrapping a *different* deployment's Pocket is
 * this compare.
 */
export async function parsePairingInvitationUrl(
  text: unknown,
  appOrigin: string,
  now: number = Date.now(),
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<PairingInvitation | null> {
  // Before `new URL`: a megabyte of text must cost a length compare, not a parse.
  if (typeof text !== 'string' || text.length > PAIRING_QR_URL_MAX_LENGTH) return null;
  const url = parseUrl(text);
  if (!url) return null;
  if (url.protocol !== 'https:') return null;
  // Credentials in the authority would let a code name an origin the compare
  // below accepts while the browser navigates somewhere else entirely.
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '') return null;
  if (url.origin !== appOrigin) return null;
  if (!url.hash.startsWith(PAIRING_HASH_PREFIX)) return null;

  const fragment = url.hash.slice(PAIRING_HASH_PREFIX.length);
  if (fragment.length !== PAIRING_FRAGMENT_LENGTH) return null;
  const fields = fragment.split(FIELD_SEPARATOR);
  if (fields.length !== 6) return null;
  const [version, hostId, inviteId, expiryText, setupToken, ephPubBase64Url] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== PAIRING_INVITATION_VERSION) return null;
  if (!isExact(hostId, ROUTING_ID_LENGTH) || !isExact(inviteId, ROUTING_ID_LENGTH)) return null;
  if (!isExact(setupToken, SECRET_LENGTH) || !isExact(ephPubBase64Url, SECRET_LENGTH)) return null;
  if (!/^[0-9]{10}$/.test(expiryText)) return null;
  const expiry = Number(expiryText);
  if (expiry > MAX_UINT32) return null;
  // Advisory only — the Host's own memory stays authoritative — but a code that
  // is already dead should fail here rather than after a handshake.
  if (expiry * 1000 < now) return null;

  let ephPub: Uint8Array;
  try {
    ephPub = fromBase64Url(ephPubBase64Url);
  } catch {
    return null;
  }
  if (ephPub.length !== NOISE_KEY_LENGTH) return null;
  try {
    // The last check, and the only expensive one: a key the suite cannot import
    // is a code no handshake could ever use.
    await crypto.subtle.importKey('raw', ephPub, { name: 'X25519' }, true, []);
  } catch {
    return null;
  }
  return { hostId, inviteId, expiry, setupToken, ephPub, ephPubBase64Url };
}
