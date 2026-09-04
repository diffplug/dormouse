/** A process-local, allocation-free token bucket for unauthenticated admission. */

export interface TokenBucketOptions {
  readonly capacity: number;
  readonly refillIntervalMs: number;
  readonly now?: () => number;
}

/**
 * Spend one token, returning `null` on success or the wait until the next one.
 * Rejected attempts allocate no per-caller state, and a forward clock jump can
 * refill at most `capacity` tokens.
 */
export class TokenBucket {
  readonly #capacity: number;
  readonly #refillIntervalMs: number;
  readonly #now: () => number;
  #tokens: number;
  #lastRefillAt: number;

  constructor({ capacity, refillIntervalMs, now = Date.now }: TokenBucketOptions) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('token bucket capacity must be a positive safe integer');
    }
    if (!Number.isSafeInteger(refillIntervalMs) || refillIntervalMs < 1) {
      throw new Error('token bucket refill interval must be a positive safe integer');
    }
    this.#capacity = capacity;
    this.#refillIntervalMs = refillIntervalMs;
    this.#now = now;
    this.#tokens = capacity;
    this.#lastRefillAt = now();
  }

  take(): number | null {
    const current = this.#now();
    const elapsed = Math.max(0, current - this.#lastRefillAt);
    const refill = Math.floor(elapsed / this.#refillIntervalMs);
    if (refill > 0) {
      this.#tokens = Math.min(this.#capacity, this.#tokens + refill);
      this.#lastRefillAt += refill * this.#refillIntervalMs;
    }
    if (this.#tokens > 0) {
      this.#tokens -= 1;
      return null;
    }
    return Math.max(1, this.#refillIntervalMs - Math.max(0, current - this.#lastRefillAt));
  }
}
