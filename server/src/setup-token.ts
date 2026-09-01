/**
 * Setup tokens: the credential behind a Host's QR (`docs/specs/server.md` →
 * "HTTP API", `POST /api/host/setup-token`).
 *
 * Server-local rather than a `HostChallengeIssuer` because the entry has to
 * remember WHICH Host minted it — that is who the redemption is announced to —
 * and the issuer stores only an expiry.
 */

import { randomBytes } from 'node:crypto';

import { toBase64Url } from 'server-lib-common';

/**
 * How long a minted token stays redeemable. Matches `DEFAULT_PAIRING_TTL_MS`
 * because the two are one window from the user's side: the nonce the token
 * leaves behind rides into the pairing request, so it must outlive the passkey
 * ceremony that stands between scanning the QR and pairing.
 */
export const SETUP_TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * How many unspent tokens the server will hold. Anything with a `hostToken`
 * can mint, and a Host that re-renders its QR in a loop would otherwise grow
 * this map for the process's lifetime; a human scans one at a time, so the cap
 * is far above any real use. Oldest is evicted first — same rule as
 * `MAX_PENDING_TICKETS` (`server-lib-common/src/security/pairing.ts`).
 */
const MAX_OUTSTANDING_TOKENS = 64;

/** 256 bits, like every other unguessable handle in this system. */
const SETUP_TOKEN_BYTE_LENGTH = 32;

export interface IssuedSetupToken {
  /** Base64url token bytes; also the handle used to peek/consume it. */
  readonly token: string;
  readonly expiresAt: number;
}

export interface SetupTokenIssuerOptions {
  /** Clock returning epoch milliseconds; injectable for tests. */
  readonly now?: () => number;
  readonly ttlMs?: number;
}

/** What a live token resolves to: the Host that minted it. */
interface SetupTokenEntry {
  readonly hostId: string;
  readonly expiresAt: number;
}

export class SetupTokenIssuer {
  readonly #tokens = new Map<string, SetupTokenEntry>();
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: SetupTokenIssuerOptions = {}) {
    this.#ttlMs = options.ttlMs ?? SETUP_TOKEN_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Mint a token for `hostId`, pruning first so the map cannot only grow. */
  issue(hostId: string): IssuedSetupToken {
    this.#prune();
    const token = toBase64Url(randomBytes(SETUP_TOKEN_BYTE_LENGTH));
    const expiresAt = this.#now() + this.#ttlMs;
    this.#tokens.set(token, { hostId, expiresAt });
    return { token, expiresAt };
  }

  /**
   * The Host that minted `token`, or `null` if it is unknown or expired. Does
   * NOT spend it: `POST /api/setup/begin` checks the credential before the
   * user has done anything, and an abandoned registration must leave the QR on
   * the laptop screen still scannable.
   */
  peek(token: string): { hostId: string } | null {
    const entry = this.#tokens.get(token);
    if (entry === undefined) return null;
    if (this.#now() >= entry.expiresAt) {
      // Reclaim it here too; an expired entry can never become valid again.
      this.#tokens.delete(token);
      return null;
    }
    return { hostId: entry.hostId };
  }

  /**
   * Spend `token`, answering the Host that minted it — or `null` when it is
   * unknown or expired. Removed either way, so it can never become valid
   * again.
   */
  consume(token: string): { hostId: string } | null {
    const entry = this.#tokens.get(token);
    if (entry === undefined) return null;
    this.#tokens.delete(token);
    return this.#now() < entry.expiresAt ? { hostId: entry.hostId } : null;
  }

  /**
   * Drop expired tokens, then evict oldest until the cap holds. Every token
   * carries the same TTL, so insertion order is expiry order and the expired
   * ones are a prefix (`HostChallengeIssuer.#sweepExpiredPrefix`, same
   * reasoning). Age alone only rate-bounds the map; the count cap is the
   * actual bound.
   */
  #prune(): void {
    const now = this.#now();
    for (const [token, entry] of this.#tokens) {
      if (now < entry.expiresAt) break;
      this.#tokens.delete(token);
    }
    while (this.#tokens.size >= MAX_OUTSTANDING_TOKENS) {
      const oldest = this.#tokens.keys().next();
      if (oldest.done) break;
      this.#tokens.delete(oldest.value);
    }
  }

  /** Outstanding tokens, for tests and the cap's own assertions. */
  get pendingCount(): number {
    return this.#tokens.size;
  }
}
