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
 *
 * **Exactly the fields of one kind — no more.** Only what
 * {@link presenceChallenge} hashes is covered by the assertion, so a binding
 * carrying an extra key would hand the Host unauthenticated data inside a
 * structure it has just verified.
 */
export function isPresenceBinding(value: unknown): value is PresenceBinding {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const fields =
    v.kind === 'pairing' ? PAIRING_FIELDS : v.kind === 'connection' ? CONNECTION_FIELDS : null;
  if (!fields) return false;
  const keys = Object.keys(v);
  return keys.length === fields.length && fields.every((field) => bounded(v[field]));
}

/** Every key one binding may carry, `kind` included, in declared order. */
const PAIRING_FIELDS = ['hostId', 'handshakeHash', 'passkeyCredentialId', 'kind'] as const;
const CONNECTION_FIELDS = [
  'hostId',
  'connectionId',
  'hostChallenge',
  'handshakeHash',
  'passkeyCredentialId',
  'kind',
] as const;

function bounded(value: unknown): value is string {
  return isBoundedString(value, PRESENCE_FIELD_LIMIT);
}

/**
 * The WebAuthn challenge for one presence assertion:
 * `SHA-256(lengthPrefixedConcat(domain, kind, …binding fields in declared
 * order, serverNonce))`, base64url. Which fields go in decoded and which as
 * UTF-8 is the spec's rule, listed there and pinned by an independently
 * computed vector in `server-lib-common/test/presence.test.mjs`;
 * {@link bindingFields} is where it is applied.
 *
 * **Throws on a field that is not base64url, and on an unbounded nonce.**
 * Callers run {@link isPresenceBinding} first and treat a throw as a failed
 * presence check, the same as a mismatch. The nonce is checked here rather
 * than there because it is not part of the binding: on the Host's recompute
 * path it arrives from the Client, and nothing else would stop a megabyte of
 * base64url from being decoded and hashed.
 */
export async function presenceChallenge(
  binding: PresenceBinding,
  serverNonce: string,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<string> {
  if (!bounded(serverNonce)) throw new Error('presence nonce is missing or over the field limit');
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
