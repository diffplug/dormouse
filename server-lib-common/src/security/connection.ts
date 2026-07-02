/**
 * Connection establishment: the Host's final access decision.
 *
 * A connection succeeds only if (spec: docs/specs/remote-security-model.md):
 *
 *   1. The passkey proves fresh user presence.
 *   2. The Server recognizes the account.       (Server-side; not decided here.)
 *   3. The Host recognizes the passkey credential.
 *   4. The Host recognizes the device key.
 *   5. The Client signed a fresh Host challenge with its device key.
 *
 * {@link authorizeConnection} is the Host side of that decision. It evaluates
 * every layer — never short-circuiting on the first failure — and allows only
 * when ALL of them pass. Requirement 2 belongs to the Server; the Host
 * repeats the account binding anyway by checking the ACL record's account,
 * because the Server is not trusted with the final decision.
 */

import { HostAcl, type HostAclRecord } from './acl.js';
import { HostChallengeIssuer } from './challenge.js';
import { verifyDeviceChallengeSignature } from './deviceKey.js';
import {
  hashPasskeyPublicKey,
  verifyPasskeyAssertion,
  type PasskeyAssertion,
  type PasskeyAssertionResult,
} from './passkey.js';
import { getWebCrypto, type WebCryptoLike } from './webcrypto.js';

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

/** The Host-side state and policy that decide a connection. */
export interface HostAuthority {
  readonly hostId: string;
  readonly acl: HostAcl;
  readonly challenges: HostChallengeIssuer;
  readonly policy: ConnectionPolicy;
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

export interface ConnectionDecision {
  readonly allowed: boolean;
  /** Empty when allowed; otherwise every layer that failed. */
  readonly failures: readonly ConnectionFailure[];
  /** The authorizing ACL record; null unless allowed. */
  readonly record: HostAclRecord | null;
  /** Passkey verification detail (e.g. `userVerified`), for logging/UI. */
  readonly passkey: PasskeyAssertionResult;
}

/**
 * The Host's final access decision. The challenge is consumed up front —
 * success or failure, a challenge can only ever be presented once.
 */
export async function authorizeConnection(
  host: HostAuthority,
  request: ConnectionRequest,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<ConnectionDecision> {
  // 5 (freshness half): burn the challenge before any other work, so it can
  // never be presented twice whatever the rest of the decision does.
  const challengeValid = host.challenges.consume(request.challenge);

  // 3 + 4: both identities must sit on the same active ACL record.
  const auth = host.acl.authorize({
    passkeyCredentialId: request.passkey.assertion.credentialId,
    devicePublicKey: request.devicePublicKey,
  });

  // The remaining checks are independent and every layer is always evaluated
  // (we never short-circuit on the first failure), so run the crypto
  // concurrently rather than in series. Hashing the presented passkey key only
  // means anything against a matched record, so it is skipped otherwise.
  // The challenge must come after the spread so nothing on the policy object
  // can ever override the freshness binding.
  const passkeyPromise = verifyPasskeyAssertion(
    request.passkey.assertion,
    request.passkey.publicKey,
    { ...host.policy, challenge: request.challenge },
    crypto,
  );
  const signaturePromise = verifyDeviceChallengeSignature(
    { hostId: host.hostId, challenge: request.challenge, devicePublicKey: request.devicePublicKey },
    request.deviceSignature,
    crypto,
  );
  // The catch is attached at creation: this promise is attacker-rejectable (a
  // malformed publicKey is not base64url), and it must never sit rejected and
  // unhandled while the earlier awaits run. null can't equal the stored hash,
  // so a malformed key denies as a mismatch.
  const keyHashPromise = auth.record
    ? hashPasskeyPublicKey(request.passkey.publicKey, crypto).catch(() => null)
    : undefined;

  const passkey = await passkeyPromise;
  const signatureValid = await signaturePromise;
  const presentedKeyHash = await keyHashPromise;

  // Assemble every failure, in spec order.
  const failures: ConnectionFailure[] = [];
  if (!challengeValid) failures.push('challenge-invalid');
  if (!passkey.ok) failures.push('passkey-assertion-invalid');
  if (auth.record === null) {
    failures.push(...auth.reasons);
  } else {
    if (presentedKeyHash !== auth.record.passkeyPublicKeyHash) {
      failures.push('passkey-key-mismatch');
    }
    if (auth.record.accountId !== request.accountId) {
      failures.push('account-mismatch');
    }
  }
  if (!signatureValid) failures.push('device-signature-invalid');

  const allowed = failures.length === 0;
  return {
    allowed,
    failures,
    record: allowed ? auth.record : null,
    passkey,
  };
}
