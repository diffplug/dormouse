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
}

export class HostChallengeIssuer {
  readonly #pending = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #crypto: WebCryptoLike;

  constructor(options: HostChallengeIssuerOptions = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
    this.#crypto = options.crypto ?? getWebCrypto();
  }

  issue(): IssuedChallenge {
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

  /** Drop expired challenges; returns how many were removed. */
  pruneExpired(): number {
    const now = this.#now();
    let pruned = 0;
    for (const [challenge, expiresAt] of this.#pending) {
      if (now >= expiresAt) {
        this.#pending.delete(challenge);
        pruned++;
      }
    }
    return pruned;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }
}
