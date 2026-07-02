/**
 * Passkeys: the fresh-user-presence primitive.
 *
 * Passkeys authenticate the user account; they never independently grant Host
 * access (they are user credentials, not device identities — they sync across
 * devices). This module verifies a WebAuthn authentication assertion so that
 * BOTH the Server and the Host can independently check fresh user presence.
 * The Host stores only a hash of each paired passkey's public key; the Client
 * presents the full key at connection time and the Host checks it against the
 * hash, so a compromised Server cannot substitute a different passkey.
 *
 * Only ES256 (ECDSA P-256 / SHA-256) is supported — the mandatory-to-implement
 * WebAuthn algorithm and what every mainstream passkey provider issues.
 */

import { concatBytes, constantTimeEqual, fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from './bytes.js';
import { ecdsaDerToRaw } from './ecdsa.js';
import { getWebCrypto, type WebCryptoLike } from './webcrypto.js';

export const PASSKEY_KEY_ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;
export const PASSKEY_SIGN_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** Authenticator-data flag bits (WebAuthn §6.1). */
const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
/** rpIdHash (32) + flags (1) + signCount (4). */
const AUTHENTICATOR_DATA_MIN_LENGTH = 37;

/** A WebAuthn authentication assertion as it travels over the wire (all base64url). */
export interface PasskeyAssertion {
  readonly credentialId: string;
  readonly clientDataJSON: string;
  readonly authenticatorData: string;
  /** ASN.1 DER ECDSA signature, as produced by authenticators. */
  readonly signature: string;
}

/** What the verifier demands of an assertion. */
export interface PasskeyAssertionExpectations {
  /** Base64url challenge the assertion must be bound to. */
  readonly challenge: string;
  /** Origin(s) the assertion may come from, e.g. `https://dormouse.dev`. */
  readonly origin: string | readonly string[];
  /** Relying-party id the credential must be scoped to, e.g. `dormouse.dev`. */
  readonly rpId: string;
  /** Require the authenticator's user-verification flag (biometric/PIN), not just presence. */
  readonly requireUserVerification?: boolean;
}

export type PasskeyAssertionFailure =
  | 'client-data-malformed'
  | 'client-data-type'
  | 'challenge-mismatch'
  | 'origin-mismatch'
  | 'authenticator-data-malformed'
  | 'rp-id-mismatch'
  | 'user-presence-missing'
  | 'user-verification-missing'
  | 'public-key-invalid'
  | 'signature-invalid';

export type PasskeyAssertionResult =
  | {
      readonly ok: true;
      readonly userPresent: true;
      readonly userVerified: boolean;
      readonly signCount: number;
    }
  | { readonly ok: false; readonly reason: PasskeyAssertionFailure };

/**
 * Verify a WebAuthn authentication assertion against the given passkey public
 * key (base64url SPKI). Never throws; returns the first failure encountered,
 * in verification order.
 */
export async function verifyPasskeyAssertion(
  assertion: PasskeyAssertion,
  passkeyPublicKey: string,
  expected: PasskeyAssertionExpectations,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<PasskeyAssertionResult> {
  let clientData: { type?: unknown; challenge?: unknown; origin?: unknown };
  let clientDataBytes: Uint8Array;
  try {
    clientDataBytes = fromBase64Url(assertion.clientDataJSON);
    const parsed: unknown = JSON.parse(utf8Decode(clientDataBytes));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    clientData = parsed;
  } catch {
    return { ok: false, reason: 'client-data-malformed' };
  }

  if (clientData.type !== 'webauthn.get') return { ok: false, reason: 'client-data-type' };
  if (
    typeof clientData.challenge !== 'string' ||
    !base64UrlValuesEqual(clientData.challenge, expected.challenge)
  ) {
    return { ok: false, reason: 'challenge-mismatch' };
  }
  const origins = typeof expected.origin === 'string' ? [expected.origin] : expected.origin;
  if (typeof clientData.origin !== 'string' || !origins.includes(clientData.origin)) {
    return { ok: false, reason: 'origin-mismatch' };
  }

  let authenticatorData: Uint8Array;
  try {
    authenticatorData = fromBase64Url(assertion.authenticatorData);
  } catch {
    return { ok: false, reason: 'authenticator-data-malformed' };
  }
  if (authenticatorData.length < AUTHENTICATOR_DATA_MIN_LENGTH) {
    return { ok: false, reason: 'authenticator-data-malformed' };
  }
  const expectedRpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', utf8Encode(expected.rpId)),
  );
  if (!constantTimeEqual(authenticatorData.subarray(0, 32), expectedRpIdHash)) {
    return { ok: false, reason: 'rp-id-mismatch' };
  }
  const flags = authenticatorData[32]!;
  if ((flags & FLAG_USER_PRESENT) === 0) return { ok: false, reason: 'user-presence-missing' };
  const userVerified = (flags & FLAG_USER_VERIFIED) !== 0;
  if (expected.requireUserVerification && !userVerified) {
    return { ok: false, reason: 'user-verification-missing' };
  }
  const signCount =
    authenticatorData[33]! * 0x1000000 +
    authenticatorData[34]! * 0x10000 +
    authenticatorData[35]! * 0x100 +
    authenticatorData[36]!;

  let publicKey;
  try {
    publicKey = await crypto.subtle.importKey(
      'spki',
      fromBase64Url(passkeyPublicKey),
      PASSKEY_KEY_ALGORITHM,
      true,
      ['verify'],
    );
  } catch {
    return { ok: false, reason: 'public-key-invalid' };
  }

  // The authenticator signs authenticatorData || SHA-256(clientDataJSON).
  const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataBytes));
  let verified: boolean;
  try {
    verified = await crypto.subtle.verify(
      PASSKEY_SIGN_ALGORITHM,
      publicKey,
      ecdsaDerToRaw(fromBase64Url(assertion.signature)),
      concatBytes(authenticatorData, clientDataHash),
    );
  } catch {
    return { ok: false, reason: 'signature-invalid' };
  }
  if (!verified) return { ok: false, reason: 'signature-invalid' };

  return { ok: true, userPresent: true, userVerified, signCount };
}

/**
 * The Host ACL stores this hash (not the key itself) at pairing time; at
 * connection time the presented key must hash to the stored value.
 */
export async function hashPasskeyPublicKey(
  passkeyPublicKey: string,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', fromBase64Url(passkeyPublicKey));
  return toBase64Url(new Uint8Array(digest));
}

/**
 * Compare two base64url strings by decoded value: browsers may re-encode the
 * challenge with padding when building clientDataJSON.
 */
function base64UrlValuesEqual(a: string, b: string): boolean {
  try {
    return constantTimeEqual(fromBase64Url(a), fromBase64Url(b));
  } catch {
    return false;
  }
}
