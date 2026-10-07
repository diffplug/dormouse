/**
 * The control messages the end-to-end ceremonies exchange once `Split` has
 * run, and the one presence verifier pairing and connection share
 * (`docs/specs/remote-security-model.md` → Presence proofs, Pairing,
 * Connection, One-time connection).
 *
 * Every message here travels as a `control` transport plaintext, which is
 * NUL-padded to a fixed size — so an approval and a denial are the same number
 * of bytes on the wire and the relay learns nothing from a length
 * (`docs/specs/relay.md` → E2E framing).
 */

import { isBoundedString } from './bytes.js';
import { CHALLENGE_BYTE_LENGTH } from './challenge.js';
import { PATH_ADDRESS_SOURCES, isIpLiteral, type PathAddressSource } from './direct-path.js';
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
  crypto?: WebCryptoLike,
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
    crypto ??= getWebCrypto();
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
 * Reject bytes 200–255 before `% 100`, leaving exactly two equally likely
 * byte values for every code.
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

/**
 * What a connection request carries in place of a proof to ride the Burrow's
 * presence window (`docs/specs/remote-security-model.md` -> Presence window).
 */
export const PRESENCE_WINDOW = 'window' as const;

/** What message 2 tells the Client it may send: a proof, or the window. */
export type ConnectionOffer = 'none' | typeof PRESENCE_WINDOW;

/** The offer byte after the challenge; an unknown one reads as `none`. */
const OFFER_BYTES: Readonly<Record<ConnectionOffer, number>> = { none: 0x00, [PRESENCE_WINDOW]: 0x01 };

/**
 * Connection message 2's payload: the Burrow's single-use challenge, then one
 * offer byte. Always {@link CHALLENGE_BYTE_LENGTH} + 1 bytes, so the offer is
 * not a length. The Client binds the **whole** payload as `burrowChallenge`.
 */
export function encodeConnectionMessage2(challenge: Uint8Array, offer: ConnectionOffer): Uint8Array {
  if (challenge.length !== CHALLENGE_BYTE_LENGTH) throw new Error('a Burrow challenge is 32 bytes');
  const payload = new Uint8Array(CHALLENGE_BYTE_LENGTH + 1);
  payload.set(challenge);
  payload[CHALLENGE_BYTE_LENGTH] = OFFER_BYTES[offer];
  return payload;
}

/**
 * The offer in a connection message 2 payload, or `null` for one of no
 * length a Burrow writes. A bare challenge is a Burrow that predates windows,
 * and offers none; an offer byte this Client does not know offers none too —
 * a proof over the whole payload still verifies.
 */
export function decodeConnectionMessage2(payload: Uint8Array): ConnectionOffer | null {
  if (payload.length === CHALLENGE_BYTE_LENGTH) return 'none';
  if (payload.length !== CHALLENGE_BYTE_LENGTH + 1) return null;
  return payload[CHALLENGE_BYTE_LENGTH] === OFFER_BYTES[PRESENCE_WINDOW] ? PRESENCE_WINDOW : 'none';
}

/**
 * The first Client→Burrow control message of a connection ceremony: a fresh
 * proof, or {@link PRESENCE_WINDOW} to redeem an open window. One required key
 * either way, padded to the same size on the wire.
 */
export interface ConnectionRequestV1 {
  readonly presence: PresenceProofV1 | typeof PRESENCE_WINDOW;
}

export function isConnectionRequestV1(value: unknown): value is ConnectionRequestV1 {
  if (!value || typeof value !== 'object') return false;
  const presence = (value as Record<string, unknown>).presence;
  return presence === PRESENCE_WINDOW || isPresenceProofV1(presence);
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

/**
 * The single Burrow→Client control message that ends a connection attempt.
 * `directOnly`, present only as `true`, says the Burrow ends this session
 * unless the direct path carries it: no application message may cross the
 * relay, and the switch has `DIRECT_ONLY_DEADLINE_MS`
 * (`docs/specs/remote-network.md` -> "Local networks"). Inside the Noise
 * session, so no Relay can add or strip it; a Client that ignores it is ended
 * at its first relayed request.
 */
export type ConnectionOutcomeV1 =
  | { readonly ok: true; readonly burrowLabel: string; readonly directOnly?: true }
  | { readonly ok: false; readonly code: ConnectionDenialCode };

export function isConnectionOutcomeV1(value: unknown): value is ConnectionOutcomeV1 {
  if (!value || typeof value !== 'object') return false;
  const outcome = value as Record<string, unknown>;
  if (outcome.ok === false) return includesCode(CONNECTION_DENIALS, outcome.code);
  return (
    outcome.ok === true &&
    bounded(outcome.burrowLabel) &&
    (outcome.directOnly === undefined || outcome.directOnly === true)
  );
}

// ---------------------------------------------------------------------------
// One-time connection (`docs/specs/one-time.md`)

/**
 * The first phone→Burrow control message of a one-time connection: the pairing
 * request's confirmation half, and no presence proof — the link and the typed
 * digits are the whole authorization, and it writes nothing.
 */
export interface OneTimeRequestV1 {
  /** The two digits the phone is displaying; the person types them on the Burrow. */
  readonly code: string;
  /**
   * The page's name for the device, one of {@link ONE_TIME_DEVICE_LABELS}. The
   * guard admits any bounded string; the Burrow shows only a member.
   */
  readonly label: string;
}

export function isOneTimeRequestV1(value: unknown): value is OneTimeRequestV1 {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  return isPairingCode(request.code) && bounded(request.label);
}

/**
 * Every label the one-time phone page sends, and the only ones a Burrow shows
 * (`docs/specs/remote-security-model.md` -> "One-time connection"). **The phone
 * chooses both the digits and the label**, and the approval modal draws the
 * label right above the input the digits go in, so free text there could tell
 * the person which digits to type. Frozen, so no importer can widen it.
 */
export const ONE_TIME_DEVICE_LABELS = Object.freeze([
  'iPhone',
  'iPad',
  'Android phone',
  'Phone browser',
] as const);

export type OneTimeDeviceLabel = (typeof ONE_TIME_DEVICE_LABELS)[number];

/** A device the page cannot name, and what a Burrow shows for any label outside the set. */
export const ONE_TIME_UNKNOWN_DEVICE_LABEL: OneTimeDeviceLabel = 'Phone browser';

/** `label` when it is exactly a member of {@link ONE_TIME_DEVICE_LABELS}, else {@link ONE_TIME_UNKNOWN_DEVICE_LABEL}. */
export function knownOneTimeDeviceLabel(label: unknown): OneTimeDeviceLabel {
  return includesCode(ONE_TIME_DEVICE_LABELS, label)
    ? (label as OneTimeDeviceLabel)
    : ONE_TIME_UNKNOWN_DEVICE_LABEL;
}

/**
 * Why a one-time connection ended without a session. Fixed copy on the phone;
 * the type is derived from the list the guard checks. Frozen and exported, so a
 * phone can map every code to copy and no importer can widen the guard.
 */
export const ONE_TIME_DENIAL_CODES = Object.freeze([
  'user-denied',
  'confirmation-mismatch',
  'link-expired',
  'burrow-error',
] as const);

export type OneTimeDenialCode = (typeof ONE_TIME_DENIAL_CODES)[number];

/**
 * The single Burrow→phone control message that ends the confirmation, either
 * way. Success carries the label and nothing a phone could keep: no Burrow
 * static to pin, no `deliveryId`.
 */
export type OneTimeOutcomeV1 =
  | { readonly ok: true; readonly burrowLabel: string }
  | { readonly ok: false; readonly code: OneTimeDenialCode };

export function isOneTimeOutcomeV1(value: unknown): value is OneTimeOutcomeV1 {
  if (!value || typeof value !== 'object') return false;
  const outcome = value as Record<string, unknown>;
  if (outcome.ok === false) return includesCode(ONE_TIME_DENIAL_CODES, outcome.code);
  return outcome.ok === true && bounded(outcome.burrowLabel);
}

// ---------------------------------------------------------------------------
// An established session

/**
 * The Burrow's goodbye: it is ending this established session on purpose, so
 * the Client reports the session over rather than waiting on requests nothing
 * will answer (`docs/specs/remote-api.md` → Transport). **Exact keys**, like
 * the direct path's signals, so nothing can ride on it: bare, or — for a
 * direct-only session the path ended (`docs/specs/remote-network.md` -> "Local
 * networks") — `reason: 'network-not-allowed'`, with the one IP literal the
 * Burrow can name and where it came from, or none. A Client that does not know
 * it ignores it, as it does every unknown control shape.
 */
export type SessionEndV1 =
  | { readonly v: 1; readonly t: 'session-end' }
  | { readonly v: 1; readonly t: 'session-end'; readonly reason: 'network-not-allowed' }
  | {
      readonly v: 1;
      readonly t: 'session-end';
      readonly reason: 'network-not-allowed';
      /** An IP literal ({@link isIpLiteral}), never a name. */
      readonly address: string;
      readonly addressSource: PathAddressSource;
    };

export const SESSION_END_V1: SessionEndV1 = Object.freeze({ v: 1, t: 'session-end' });

export function isSessionEndV1(value: unknown): value is SessionEndV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.v !== 1 || message.t !== 'session-end') return false;
  const keys = Object.keys(message).length;
  if (keys === 2) return true;
  if (message.reason !== 'network-not-allowed') return false;
  if (keys === 3) return true;
  return (
    keys === 5 && isIpLiteral(message.address) && includesCode(PATH_ADDRESS_SOURCES, message.addressSource)
  );
}

/** Membership in a denial list, without widening the list's literal type. */
function includesCode(codes: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && codes.includes(value);
}
