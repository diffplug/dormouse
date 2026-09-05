/**
 * The control messages both end-to-end ceremonies exchange once `Split` has
 * run, and the one presence verifier they share
 * (`docs/specs/remote-security-model.md` → Presence proofs, Pairing,
 * Connection).
 *
 * Every message here travels as a `control` transport plaintext, which is
 * NUL-padded to a fixed size — so an approval and a denial are the same number
 * of bytes on the wire and the relay learns nothing from a length
 * (`docs/specs/relay.md` → E2E framing).
 */

import { isBoundedString } from './bytes.js';
import {
  hashPasskeyPublicKey,
  verifyPasskeyAssertion,
  type ConnectionPolicy,
  type PasskeyAssertion,
} from './passkey.js';
import { presenceChallenge, isPresenceBinding, type PresenceBinding } from './presence.js';
import { getWebCrypto, type WebCryptoLike } from './webcrypto.js';

/**
 * The longest any single field of a ceremony control message may be. Same rule
 * and headroom as `PRESENCE_FIELD_LIMIT`: every real field is a routing id, a
 * base64url key, a credential id, or a device label, and a type check alone
 * bounds nothing — a megabyte string is a `string`.
 */
export const CEREMONY_FIELD_LIMIT = 1024;

function bounded(value: unknown): value is string {
  return isBoundedString(value, CEREMONY_FIELD_LIMIT);
}

// ---------------------------------------------------------------------------
// The presence proof

/**
 * What a Client presents to prove fresh user presence inside a ceremony. It
 * travels only inside the first Client→Burrow transport payload, so it is
 * confidential to the pair and bound to their transcript through
 * {@link PresenceBinding}.
 */
export interface PresenceProofV1 {
  readonly binding: PresenceBinding;
  /** The Relay's single-use nonce from `POST /api/reauth/begin`, base64url. */
  readonly relayNonce: string;
  readonly accountId: string;
  readonly passkeyCredentialId: string;
  /** The canonical SPKI public key, base64url — presented in full, checked by hash. */
  readonly passkeyPublicKey: string;
  readonly assertion: PasskeyAssertion;
}

function isPasskeyAssertion(value: unknown): value is PasskeyAssertion {
  if (!value || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  return (
    bounded(a.credentialId) &&
    // clientDataJSON and authenticatorData are the two fields that legitimately
    // carry structure, so they get the same bound rather than a tighter one.
    bounded(a.clientDataJSON) &&
    bounded(a.authenticatorData) &&
    bounded(a.signature)
  );
}

/**
 * Structural validation of a {@link PresenceProofV1} the Burrow has decrypted but
 * not yet believed. Bounded field by field: the payload is authenticated by
 * Noise, which proves *who* sent it, never that its contents are well-formed.
 */
export function isPresenceProofV1(value: unknown): value is PresenceProofV1 {
  if (!value || typeof value !== 'object') return false;
  const proof = value as Record<string, unknown>;
  return (
    isPresenceBinding(proof.binding) &&
    bounded(proof.relayNonce) &&
    bounded(proof.accountId) &&
    bounded(proof.passkeyCredentialId) &&
    bounded(proof.passkeyPublicKey) &&
    isPasskeyAssertion(proof.assertion)
  );
}

export type PresenceProofFailure =
  /** The proof was not a {@link PresenceProofV1} at all. */
  | 'malformed'
  /** A binding field, or its kind, differs from what this ceremony expects. */
  | 'binding-mismatch'
  /** The credential the assertion names is not the one the binding does. */
  | 'credential-mismatch'
  /** The derived challenge could not be computed from the presented values. */
  | 'challenge-underivable'
  /** `verifyPasskeyAssertion` rejected it. */
  | 'assertion-invalid';

export type PresenceProofResult =
  | { readonly ok: true; readonly passkeyPublicKeyHash: string }
  | { readonly ok: false; readonly reason: PresenceProofFailure };

/**
 * The one presence verifier both ceremonies run — pairing and connection differ
 * only in the binding they pass as `expected`, which the caller must have built
 * from its own state (`docs/specs/remote-security-model.md` → Presence proofs).
 *
 * **Never throws**, so a caller may treat every rejection as an ordinary denial.
 */
export async function verifyPresenceProof(
  proof: unknown,
  expected: PresenceBinding,
  policy: ConnectionPolicy,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<PresenceProofResult> {
  if (!isPresenceProofV1(proof)) return { ok: false, reason: 'malformed' };
  if (!bindingEquals(proof.binding, expected)) return { ok: false, reason: 'binding-mismatch' };
  // The binding covers `passkeyCredentialId`; the assertion carries its own.
  // Requiring them equal is what keeps the verified key and the bound identity
  // one identity rather than two that merely travelled together.
  if (proof.assertion.credentialId !== proof.binding.passkeyCredentialId) {
    return { ok: false, reason: 'credential-mismatch' };
  }
  if (proof.passkeyCredentialId !== proof.binding.passkeyCredentialId) {
    return { ok: false, reason: 'credential-mismatch' };
  }
  let challenge: string;
  try {
    challenge = await presenceChallenge(proof.binding, proof.relayNonce, crypto);
  } catch {
    // A non-base64url binding field or an over-long nonce; the builder throws
    // and the caller treats it exactly as a mismatch.
    return { ok: false, reason: 'challenge-underivable' };
  }
  const result = await verifyPasskeyAssertion(
    proof.assertion,
    proof.passkeyPublicKey,
    { challenge, origin: policy.origin, rpId: policy.rpId, requireUserVerification: policy.requireUserVerification },
    crypto,
  );
  if (!result.ok) return { ok: false, reason: 'assertion-invalid' };
  let passkeyPublicKeyHash: string;
  try {
    passkeyPublicKeyHash = await hashPasskeyPublicKey(proof.passkeyPublicKey, crypto);
  } catch {
    return { ok: false, reason: 'assertion-invalid' };
  }
  return { ok: true, passkeyPublicKeyHash };
}

/** Field-for-field equality of two bindings of the same kind. */
function bindingEquals(left: PresenceBinding, right: PresenceBinding): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'pairing' && right.kind === 'pairing') {
    return (
      left.burrowId === right.burrowId &&
      left.handshakeHash === right.handshakeHash &&
      left.passkeyCredentialId === right.passkeyCredentialId
    );
  }
  if (left.kind === 'connection' && right.kind === 'connection') {
    return (
      left.burrowId === right.burrowId &&
      left.connectionId === right.connectionId &&
      left.burrowChallenge === right.burrowChallenge &&
      left.handshakeHash === right.handshakeHash &&
      left.passkeyCredentialId === right.passkeyCredentialId
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// The two-digit confirmation code

/** A pairing code is exactly two ASCII digits, `00`–`99`. */
export const PAIRING_CODE_LENGTH = 2;

/** The smallest byte value that would bias a `% 100` reduction; see below. */
const PAIRING_CODE_REJECT_AT = 200;

/**
 * A uniform pairing code, `00`–`99`.
 *
 * Rejection sampling rather than `% 100`: a byte reduces to 0–55 with
 * probability 3/256 and to 56–99 with 2/256, so a modulo would make a fifth of
 * the code space over twice as likely as the rest — a 100-way secret is small
 * enough that the bias is worth removing.
 */
export function samplePairingCode(crypto: WebCryptoLike = getWebCrypto()): string {
  const byte = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(byte);
    if (byte[0]! < PAIRING_CODE_REJECT_AT) {
      return String(byte[0]! % 100).padStart(PAIRING_CODE_LENGTH, '0');
    }
  }
}

/** Whether a value is a well-formed pairing code. */
export function isPairingCode(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{2}$/.test(value);
}

// ---------------------------------------------------------------------------
// Pairing

/** The first Client→Burrow control message of a pairing ceremony. */
export interface PairingRequestV1 {
  /** The two digits the phone is displaying; the person types them on the Burrow. */
  readonly code: string;
  /** The Client's own name for itself, shown in the approval modal. */
  readonly label: string;
  readonly presence: PresenceProofV1;
}

export function isPairingRequestV1(value: unknown): value is PairingRequestV1 {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  return isPairingCode(request.code) && bounded(request.label) && isPresenceProofV1(request.presence);
}

/**
 * Why a pairing ended without an ACL record. Fixed copy on the Client, and the
 * type is derived from the list the guard checks so the two cannot drift.
 */
const PAIRING_DENIALS = [
  'user-denied',
  'confirmation-mismatch',
  'presence-rejected',
  'invitation-expired',
  'superseded',
  'burrow-error',
] as const;

export type PairingDenialCode = (typeof PAIRING_DENIALS)[number];

/** The single Burrow→Client control message that ends a pairing, either way. */
export type PairingOutcomeV1 =
  | {
      readonly ok: true;
      /** The Burrow's long-term Noise static, base64url — the Client's pin from here on. */
      readonly burrowStaticPublicKey: string;
      /** The Burrow's local label; it exists nowhere on the Relay. */
      readonly burrowLabel: string;
      readonly accountId: string;
      readonly passkeyCredentialId: string;
      readonly passkeyPublicKeyHash: string;
      /** The bearer capability for this Client's push rows on this Burrow. */
      readonly deliveryId: string;
    }
  | { readonly ok: false; readonly code: PairingDenialCode };

export function isPairingOutcomeV1(value: unknown): value is PairingOutcomeV1 {
  if (!value || typeof value !== 'object') return false;
  const outcome = value as Record<string, unknown>;
  if (outcome.ok === false) return includesCode(PAIRING_DENIALS, outcome.code);
  if (outcome.ok !== true) return false;
  return (
    bounded(outcome.burrowStaticPublicKey) &&
    bounded(outcome.burrowLabel) &&
    bounded(outcome.accountId) &&
    bounded(outcome.passkeyCredentialId) &&
    bounded(outcome.passkeyPublicKeyHash) &&
    bounded(outcome.deliveryId)
  );
}

// ---------------------------------------------------------------------------
// Connection

/** The first Client→Burrow control message of a connection ceremony. */
export interface ConnectionRequestV1 {
  readonly presence: PresenceProofV1;
}

export function isConnectionRequestV1(value: unknown): value is ConnectionRequestV1 {
  if (!value || typeof value !== 'object') return false;
  return isPresenceProofV1((value as Record<string, unknown>).presence);
}

/**
 * Why a connection was refused. **Every ACL miss is `pairing-required`**: which
 * half of the conjunction failed is logged owner-locally and never returned
 * (`docs/specs/remote-security-model.md` → Connection).
 */
const CONNECTION_DENIALS = [
  'pairing-required',
  'presence-rejected',
  'protocol-rejected',
  'burrow-busy',
  'burrow-error',
] as const;

export type ConnectionDenialCode = (typeof CONNECTION_DENIALS)[number];

/** The single Burrow→Client control message that ends a connection attempt. */
export type ConnectionOutcomeV1 =
  | { readonly ok: true; readonly burrowLabel: string }
  | { readonly ok: false; readonly code: ConnectionDenialCode };

export function isConnectionOutcomeV1(value: unknown): value is ConnectionOutcomeV1 {
  if (!value || typeof value !== 'object') return false;
  const outcome = value as Record<string, unknown>;
  if (outcome.ok === false) return includesCode(CONNECTION_DENIALS, outcome.code);
  return outcome.ok === true && bounded(outcome.burrowLabel);
}

/** Membership in a denial list, without widening the list's literal type. */
function includesCode(codes: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && codes.includes(value);
}
