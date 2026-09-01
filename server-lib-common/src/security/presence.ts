/**
 * The presence challenge both ceremonies prove freshness with
 * (`docs/specs/remote-security-model.md` -> E2E identities and presence).
 *
 * The WebAuthn challenge is derived, not random: it is a hash over the
 * ceremony this assertion belongs to, so an assertion produced for one pairing
 * or connection authenticates nothing anywhere else. Shared, because the
 * Server mints the challenge and the Host recomputes it — a second
 * implementation of these bytes would be a second opinion about what a valid
 * assertion is.
 *
 * Nothing calls this yet; the routes and the verifier land with the ceremony
 * cutover.
 */

import {
  fromBase64Url,
  isBoundedString,
  lengthPrefixedConcat,
  toBase64Url,
  utf8Encode,
} from './bytes.js';
import { getWebCrypto, type WebCryptoLike } from './webcrypto.js';

/** One domain per signed statement, like every other in this package. */
export const PRESENCE_DOMAIN = 'dormouse/presence/v1';

/**
 * The longest any single binding field may be. Same rule and roughly the same
 * headroom as `PAIRING_FIELD_LIMIT`: every real field is a routing id, a
 * 32-byte base64url value, or a credential id.
 */
export const PRESENCE_FIELD_LIMIT = 1024;

/**
 * What one presence assertion is bound to. Kind-tagged and closed: `pairing`
 * has no connection to name yet, and a `connection` binding that could omit
 * its Host challenge would be a pairing proof replayed at connect time.
 */
export type PresenceBinding =
  | {
      readonly kind: 'pairing';
      readonly hostId: string;
      /** Noise's final handshake hash, base64url. */
      readonly handshakeHash: string;
      readonly passkeyCredentialId: string;
    }
  | {
      readonly kind: 'connection';
      readonly hostId: string;
      /** This connection's id, base64url. */
      readonly connectionId: string;
      /** The Host's single-use challenge, base64url. */
      readonly hostChallenge: string;
      /** Noise's final handshake hash, base64url. */
      readonly handshakeHash: string;
      readonly passkeyCredentialId: string;
    };

/**
 * Structural validation of a {@link PresenceBinding} off the wire, run by
 * every side that receives one: the Server takes it from a Client, and the
 * Host takes it from inside a transport payload it has decrypted but not yet
 * believed.
 */
export function isPresenceBinding(value: unknown): value is PresenceBinding {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!bounded(v.hostId) || !bounded(v.handshakeHash) || !bounded(v.passkeyCredentialId)) {
    return false;
  }
  if (v.kind === 'pairing') return true;
  if (v.kind === 'connection') return bounded(v.connectionId) && bounded(v.hostChallenge);
  return false;
}

function bounded(value: unknown): value is string {
  return isBoundedString(value, PRESENCE_FIELD_LIMIT);
}

/**
 * The WebAuthn challenge for one presence assertion:
 * `SHA-256(lengthPrefixedConcat(domain, kind, …binding fields in declared
 * order, serverNonce))`, base64url.
 *
 * **One encoding rule, applied everywhere: a base64url field is hashed as the
 * bytes it encodes, and everything else as UTF-8.** The decoded fields are
 * `connectionId`, `hostChallenge`, `handshakeHash`, and the Server nonce; the
 * domain, the kind, `hostId`, and `passkeyCredentialId` are opaque strings and
 * go in as text. Both sides compute the same bytes only if they agree about
 * this, so it is stated once here and pinned by an independently computed test
 * vector.
 *
 * `lengthPrefixedConcat` is what keeps the fields from sliding past each
 * other — no value can be split differently and hash the same.
 *
 * **Throws on a field that is not base64url.** Callers run
 * {@link isPresenceBinding} first and treat a throw as a failed presence
 * check, the same as a mismatch.
 */
export async function presenceChallenge(
  binding: PresenceBinding,
  serverNonce: string,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    lengthPrefixedConcat([
      utf8Encode(PRESENCE_DOMAIN),
      utf8Encode(binding.kind),
      ...bindingFields(binding),
      fromBase64Url(serverNonce),
    ]),
  );
  return toBase64Url(new Uint8Array(digest));
}

/** The binding's own fields, in the order the type declares them. */
function bindingFields(binding: PresenceBinding): Uint8Array[] {
  if (binding.kind === 'pairing') {
    return [
      utf8Encode(binding.hostId),
      fromBase64Url(binding.handshakeHash),
      utf8Encode(binding.passkeyCredentialId),
    ];
  }
  return [
    utf8Encode(binding.hostId),
    fromBase64Url(binding.connectionId),
    fromBase64Url(binding.hostChallenge),
    fromBase64Url(binding.handshakeHash),
    utf8Encode(binding.passkeyCredentialId),
  ];
}
