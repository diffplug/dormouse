/**
 * Server-side handshake verification (docs/specs/server.md "Relay";
 * docs/specs/remote-security-model.md). The {@link RelayHub} stays a
 * transport-dumb pipe — this module is the policy it consults before forwarding
 * the two security-critical Client frames:
 *
 *   - `pair`:     the pairing request must be consistent with the authenticated
 *                 session — the owner account, a registered passkey credential,
 *                 and the matching stored public-key hash. Otherwise the server
 *                 refuses to relay it to the Host at all.
 *   - `connect2`: the WebAuthn assertion must verify against the STORED passkey
 *                 public key (not the one the request carries), over the exact
 *                 Host challenge the server just relayed to this client. This is
 *                 the Server's half of "fresh user presence is validated by the
 *                 Server and the Host".
 *
 * A rejection never reaches the Host, so a forged request cannot even burn a
 * Host challenge. The relayed challenge is single-use on the server side too, so
 * a replayed `connect2` is refused here before it is forwarded. The Host's
 * `authorizeConnection` remains the final authority on everything the server
 * cannot see (the ACL, the device key, the challenge it actually issued).
 */

import {
  DEFAULT_CHALLENGE_TTL_MS,
  SELFHOST_ACCOUNT_ID,
  hashPasskeyPublicKey,
  verifyPasskeyAssertion,
} from 'server-lib-common';
import type { ConnectionFailure, ConnectionRequest, PairingRequest } from 'server-lib-common';

import type { AccountStore } from './state.js';

/** Result of {@link HandshakeGate.checkPair}. */
export type PairCheck = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** Result of {@link HandshakeGate.checkConnect2}. Failures reuse the Host's vocabulary. */
export type Connect2Check =
  | { readonly ok: true }
  | { readonly ok: false; readonly failures: readonly ConnectionFailure[] };

/**
 * The policy surface the {@link RelayHub} consults. Kept as an interface so the
 * hub depends on the contract, not the concrete {@link Handshake}, and stays
 * transport-dumb.
 */
export interface HandshakeGate {
  /** Verify a `pair` request before relaying it to the Host. */
  checkPair(request: unknown): Promise<PairCheck>;
  /** Remember the Host challenge the server just relayed to a client (freshness half). */
  observeChallenge(clientId: string, hostId: string, challenge: string, expiresAt: number): void;
  /** Verify a `connect2` request before relaying it to the Host. */
  checkConnect2(clientId: string, request: ConnectionRequest): Promise<Connect2Check>;
  /** Drop any remembered challenge for a client that disconnected. */
  forgetClient(clientId: string): void;
}

export interface HandshakeConfig {
  /** External origin the WebAuthn assertion must have been produced for. */
  readonly origin: string;
  /** Relying-party id the assertion must be scoped to. */
  readonly rpId: string;
  /**
   * Demand the authenticator's user-verification flag (biometric/PIN), not just
   * user presence. This must mirror the Host's `ConnectionPolicy.requireUserVerification`
   * (connection.ts `authorizeConnection`): both verifiers evaluate the same
   * assertion, so if only one demands UV they silently disagree on what a valid
   * assertion is. Undefined/false keeps the current presence-only behavior.
   */
  readonly requireUserVerification?: boolean;
  /** Injectable clock (epoch ms) for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Relay-side TTL for Host challenges observed by the server. */
  readonly relayedChallengeTtlMs?: number;
}

/** The last Host challenge the server relayed to a client. */
interface RelayedChallenge {
  readonly hostId: string;
  readonly challenge: string;
  /** Server-local expiry, derived when the relay observed the challenge. */
  readonly expiresAt: number;
}

export class Handshake implements HandshakeGate {
  readonly #accounts: AccountStore;
  readonly #origin: string;
  readonly #rpId: string;
  readonly #requireUserVerification: boolean;
  readonly #now: () => number;
  readonly #relayedChallengeTtlMs: number;
  /** clientId → the last Host challenge relayed to it; consumed single-use. */
  readonly #relayed = new Map<string, RelayedChallenge>();

  constructor(accounts: AccountStore, config: HandshakeConfig) {
    this.#accounts = accounts;
    this.#origin = config.origin;
    this.#rpId = config.rpId;
    this.#requireUserVerification = config.requireUserVerification ?? false;
    this.#now = config.now ?? (() => Date.now());
    this.#relayedChallengeTtlMs = config.relayedChallengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
  }

  async checkPair(request: unknown): Promise<PairCheck> {
    if (!isPairingRequest(request)) {
      return { ok: false, error: 'malformed pairing request' };
    }
    if (request.accountId !== SELFHOST_ACCOUNT_ID) {
      return { ok: false, error: 'pairing request is not for this account' };
    }
    if (typeof request.passkeyCredentialId !== 'string') {
      return { ok: false, error: 'pairing request has no passkey credential' };
    }
    const stored = await this.#accounts.findPasskey(request.passkeyCredentialId);
    if (!stored) {
      return { ok: false, error: 'passkey credential is not registered to this account' };
    }
    const expectedHash = await hashPasskeyPublicKey(stored.publicKey);
    if (request.passkeyPublicKeyHash !== expectedHash) {
      return { ok: false, error: 'passkey public key hash does not match the registered key' };
    }
    return { ok: true };
  }

  observeChallenge(clientId: string, hostId: string, challenge: string, _hostExpiresAt: number): void {
    this.#relayed.set(clientId, {
      hostId,
      challenge,
      expiresAt: this.#now() + this.#relayedChallengeTtlMs,
    });
  }

  forgetClient(clientId: string): void {
    this.#relayed.delete(clientId);
  }

  async checkConnect2(clientId: string, request: ConnectionRequest): Promise<Connect2Check> {
    const failures: ConnectionFailure[] = [];

    // (d) Freshness half: the request must answer the exact Host challenge the
    // server relayed to THIS client, unexpired. Consume it unconditionally
    // (single-use) so a replayed connect2 is refused here before forwarding.
    const relayed = this.#relayed.get(clientId);
    this.#relayed.delete(clientId);
    const challengeFresh =
      relayed !== undefined &&
      typeof request?.challenge === 'string' &&
      relayed.challenge === request.challenge &&
      this.#now() < relayed.expiresAt;
    if (!challengeFresh) failures.push('challenge-invalid');

    // (a) Only the single owner account.
    if (!request || request.accountId !== SELFHOST_ACCOUNT_ID) failures.push('account-mismatch');

    // (b) The asserted credential must be a registered passkey, and the request's
    // publicKey must equal the STORED key for it (plain string compare).
    const assertion = request?.passkey?.assertion;
    const credentialId = assertion?.credentialId;
    const stored =
      typeof credentialId === 'string' ? await this.#accounts.findPasskey(credentialId) : undefined;
    if (!stored) {
      failures.push('passkey-not-paired');
    } else if (request.passkey.publicKey !== stored.publicKey) {
      failures.push('passkey-key-mismatch');
    }

    // (c) The assertion must verify against the STORED key over request.challenge.
    // Verifying against the stored key — never against request.passkey.publicKey —
    // is what makes a substituted publicKey useless to an attacker.
    if (stored && assertion && typeof request.challenge === 'string') {
      const result = await verifyPasskeyAssertion(assertion, stored.publicKey, {
        challenge: request.challenge,
        origin: this.#origin,
        rpId: this.#rpId,
        // Mirror the Host's UV demand so Server and Host cannot drift on what a
        // valid assertion is (connection.ts `authorizeConnection`).
        requireUserVerification: this.#requireUserVerification,
      });
      if (!result.ok) failures.push('passkey-assertion-invalid');
    } else {
      failures.push('passkey-assertion-invalid');
    }

    return failures.length === 0 ? { ok: true } : { ok: false, failures };
  }
}

function isPairingRequest(request: unknown): request is PairingRequest {
  return (
    !!request &&
    typeof request === 'object' &&
    typeof (request as PairingRequest).accountId === 'string' &&
    typeof (request as PairingRequest).passkeyCredentialId === 'string' &&
    typeof (request as PairingRequest).passkeyPublicKeyHash === 'string' &&
    typeof (request as PairingRequest).devicePublicKey === 'string' &&
    typeof (request as PairingRequest).requestedLabel === 'string'
  );
}
