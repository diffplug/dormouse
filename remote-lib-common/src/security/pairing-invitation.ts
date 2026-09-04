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

import { base64UrlLength, fromBase64Url, isExactBase64Url } from './bytes.js';
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

/** The one spelling of an expiry field, built from {@link EXPIRY_DIGITS}. */
const EXPIRY_PATTERN = new RegExp(`^[0-9]{${EXPIRY_DIGITS}}$`);

/** The largest epoch-seconds value a uint32 expiry may carry. */
const MAX_UINT32 = 0xffff_ffff;

/**
 * The three origins the documented dev loop serves Pocket from, and the whole
 * of the parser's HTTPS exemption. **Matched by exact host, and deliberately
 * narrower than the platform's own secure-context rule**, which also trusts
 * `*.localhost` and all of `127.0.0.0/8`: this is a policy list, not a
 * re-derivation, so widening it is a decision rather than a correction.
 * `URL.hostname` spells the IPv6 loopback bracketed, so that is the form here.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** How many dot-delimited fields the fragment carries. */
const FRAGMENT_FIELD_COUNT = 6;

/**
 * The positional fragment's exact length: every field plus its separators.
 * Fixed, because every field is fixed — a fragment of any other length is
 * rejected before a single field is read.
 */
export const PAIRING_FRAGMENT_LENGTH =
  PAIRING_INVITATION_VERSION.length +
  ROUTING_ID_LENGTH * 2 +
  EXPIRY_DIGITS +
  SECRET_LENGTH * 2 +
  (FRAGMENT_FIELD_COUNT - 1);

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
  // Through {@link pairingInvitationFields}, so the fragment and the prologue
  // cannot disagree about order: the version leads, the `hostId` follows it, and
  // the rest is exactly what the transcript binds.
  const [version, ...rest] = pairingInvitationFields(invitation);
  const fragment = [version, invitation.hostId, ...rest].join(FIELD_SEPARATOR);
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
 *
 * **HTTPS, or plain HTTP on one of {@link LOOPBACK_HOSTS}.** Every one of those
 * is a secure context by the platform's own rule, so the exemption admits no
 * origin WebAuthn or a service worker would refuse to run on.
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
  // The origin compare below still has to pass, so this widens nothing a
  // remote code could reach — see {@link LOOPBACK_HOSTS}.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    return null;
  }
  // Credentials in the authority would let a code name an origin the compare
  // below accepts while the browser navigates somewhere else entirely.
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '') return null;
  if (url.origin !== appOrigin) return null;
  if (!url.hash.startsWith(PAIRING_HASH_PREFIX)) return null;

  const fragment = url.hash.slice(PAIRING_HASH_PREFIX.length);
  if (fragment.length !== PAIRING_FRAGMENT_LENGTH) return null;
  const fields = fragment.split(FIELD_SEPARATOR);
  if (fields.length !== FRAGMENT_FIELD_COUNT) return null;
  const [version, hostId, inviteId, expiryText, setupToken, ephPubBase64Url] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== PAIRING_INVITATION_VERSION) return null;
  if (!isExactBase64Url(hostId, ROUTING_ID_LENGTH) || !isExactBase64Url(inviteId, ROUTING_ID_LENGTH))
    return null;
  if (!isExactBase64Url(setupToken, SECRET_LENGTH) || !isExactBase64Url(ephPubBase64Url, SECRET_LENGTH))
    return null;
  if (!EXPIRY_PATTERN.test(expiryText)) return null;
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

/**
 * Whether a code {@link parsePairingInvitationUrl} refused is one this app
 * *would* have taken, had it been scanned before its expiry.
 *
 * The parser answers a complete invitation or nothing and never a reason, which
 * is what keeps "never a partial parse" true — so an expired code and a QR off
 * a cereal box are one answer there. They are not one answer to a *user*: the
 * first is fixed by showing a fresh code, the second by scanning something
 * else. This is the whole of the difference, for a caller that already has a
 * `null` and wants to say which.
 *
 * **Never `true` for anything the parser refuses on any other rule.** Answered
 * by running that same parser at the epoch, so the structural rules and the
 * origin compare are literally the shipped ones and cannot drift from a second
 * copy — a foreign-origin code is not a setup code for this server whether or
 * not its expiry has passed. It reads nothing the user is not already holding.
 */
export async function pairingInvitationExpired(
  text: unknown,
  appOrigin: string,
  now: number = Date.now(),
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<boolean> {
  // No invitation can already be expired at the epoch, so this parse applies
  // every rule *but* the expiry one.
  const invitation = await parsePairingInvitationUrl(text, appOrigin, 0, crypto);
  return invitation !== null && invitation.expiry * 1000 < now;
}
