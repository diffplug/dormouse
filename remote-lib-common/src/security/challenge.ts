/**
 * Host challenges: the freshness primitive.
 *
 * Every connection attempt consumes a challenge that the Host itself issued
 * moments earlier. Challenges are unguessable (256 bits), expire quickly, and
 * are single-use — consuming one removes it whether or not the rest of the
 * connection attempt succeeds, so a captured request can never be replayed.
 */

import { toBase64Url } from './bytes.js';
import { getWebCrypto, type WebCryptoLike } from './webcrypto.js';

export const CHALLENGE_BYTE_LENGTH = 32;
export const DEFAULT_CHALLENGE_TTL_MS = 2 * 60 * 1000;

export interface IssuedChallenge {
  /** Base64url challenge bytes; also the handle used to consume it. */
  readonly challenge: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface HostChallengeIssuerOptions {
  readonly ttlMs?: number;
  /** Clock returning epoch milliseconds; injectable for tests. */
  readonly now?: () => number;
  readonly crypto?: WebCryptoLike;
  /**
   * Hard ceiling on outstanding challenges; the oldest go first once it is
   * reached. Optional because the expiry sweep alone bounds an issuer whose
   * `issue` is behind a credential — but where minting needs no auth at all
   * (`POST /api/signin/begin`), the sweep only makes the map plateau at
   * request-rate x TTL, which is not a bound the process chose. A caller that
   * sets this accepts that a flood evicts live challenges: the abandoned
   * ceremony retries, and single-use is unaffected.
   */
  readonly maxPending?: number;
}

export class HostChallengeIssuer {
  readonly #pending = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #crypto: WebCryptoLike;
  readonly #maxPending: number;

  constructor(options: HostChallengeIssuerOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#crypto = options.crypto ?? getWebCrypto();
    this.#maxPending = options.maxPending ?? Number.POSITIVE_INFINITY;
  }

  issue(): IssuedChallenge {
    this.#sweepExpiredPrefix();
    // Oldest first, and only once expiry has already reclaimed what it can:
    // every challenge carries the same TTL, so insertion order is expiry order
    // and the front of the map is the closest to dying anyway.
    while (this.#pending.size >= this.#maxPending) {
      const oldest = this.#pending.keys().next();
      if (oldest.done) break;
      this.#pending.delete(oldest.value);
    }
    const bytes = this.#crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTE_LENGTH));
    const challenge = toBase64Url(bytes);
    const issuedAt = this.#now();
    const expiresAt = issuedAt + this.#ttlMs;
    this.#pending.set(challenge, expiresAt);
    return { challenge, issuedAt, expiresAt };
  }

  /**
   * Redeem a challenge. True only if this issuer issued it, it has not
   * expired, and it has not been consumed before. The challenge is removed
   * even when expired, so it can never become valid again.
   */
  consume(challenge: string): boolean {
    const expiresAt = this.#pending.get(challenge);
    if (expiresAt === undefined) return false;
    this.#pending.delete(challenge);
    return this.#now() < expiresAt;
  }

  /**
   * Drop expired challenges from the FRONT of `#pending`, stopping at the first
   * one still live. Every challenge a given issuer mints carries the same
   * `ttlMs`, so insertion order is expiry order and the expired ones are always
   * a prefix — which makes this amortized O(1) per `issue` rather than a scan.
   *
   * `issue` has to do this because nothing else reclaims: `consume` removes only
   * challenges someone actually redeemed, and every flow here routinely abandons
   * one. `POST /api/signin/begin` (`server/src/app.ts`) is the sharp case — it
   * mints before the caller is authenticated at all, so without a sweep an
   * unauthenticated client can grow `#pending` for the process's lifetime just
   * by asking.
   *
   * A rewinding injected clock only makes this reclaim less, never wrong: it
   * deletes solely entries already past `expiresAt` and stops at the first live
   * one, so a head that looks live under the rewound clock costs retention, not
   * correctness.
   */
  #sweepExpiredPrefix(): void {
    const now = this.#now();
    for (const [challenge, expiresAt] of this.#pending) {
      if (now < expiresAt) return;
      this.#pending.delete(challenge);
    }
  }

  get pendingCount(): number {
    return this.#pending.size;
  }
}
