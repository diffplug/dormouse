/**
 * The legacy connect2 request shape and the policy both verifiers share.
 *
 * The Host's own connection decision is now the end-to-end ceremony —
 * `e2e-ceremony.ts` (`ConnectionRequestV1`, `verifyPresenceProof`,
 * `ConnectionOutcomeV1`) over the ACL conjunction in `acl.ts`.
 * {@link ConnectionPolicy} stays here because it is what a Host enrolls with
 * and what both the Server and the Host demand of an assertion.
 *
 * STAGE-4 TRANSITIONAL: {@link ConnectionRequest} and {@link ConnectionFailure}
 * remain only for the legacy relay path (`server/src/handshake.ts`) and the
 * Pocket client that has not switched yet; both are deleted in 4c.
 */

import type { PasskeyAssertion } from './passkey.js';

/** What a Client submits to open a session (all binary fields base64url). */
export interface ConnectionRequest {
  readonly accountId: string;
  /** The Client identity claimed for this connection (see deviceKey.ts). */
  readonly devicePublicKey: string;
  /** The Host challenge this request answers. */
  readonly challenge: string;
  /** Device-key signature over the challenge (see deviceKey.ts `signDeviceChallenge`). */
  readonly deviceSignature: string;
  readonly passkey: {
    /** Full SPKI public key; the Host checks it against the ACL's stored hash. */
    readonly publicKey: string;
    /** WebAuthn assertion bound to the same Host challenge. */
    readonly assertion: PasskeyAssertion;
  };
}

export interface ConnectionPolicy {
  /** Relying-party id passkey assertions must be scoped to, e.g. `dormouse.dev`. */
  readonly rpId: string;
  /** Web origin(s) Clients may connect from. */
  readonly origin: string | readonly string[];
  /** Demand biometric/PIN user verification, not just user presence. */
  readonly requireUserVerification?: boolean;
}

export type ConnectionFailure =
  /** Challenge unknown, expired, or already used. */
  | 'challenge-invalid'
  /** WebAuthn assertion failed; see `passkey.reason` on the decision. */
  | 'passkey-assertion-invalid'
  /** No active ACL record includes this passkey credential. */
  | 'passkey-not-paired'
  /** No active ACL record includes this device key. */
  | 'device-not-paired'
  /** Passkey and device key are each paired, but never together. */
  | 'pairing-mismatch'
  /** Presented passkey public key does not hash to the ACL's stored hash. */
  | 'passkey-key-mismatch'
  /** The ACL record was approved for a different account. */
  | 'account-mismatch'
  /** Device-key signature over the Host challenge did not verify. */
  | 'device-signature-invalid';
