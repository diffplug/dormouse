/**
 * A process-local, allocation-free token bucket.
 *
 * Refills in whole intervals and carries the remainder, so a clock read every
 * few hundred milliseconds cannot round its way to a faster sustained rate; a
 * rewinding clock costs refill, never correctness, and a forward jump refills
 * at most `capacity`. Rejected attempts allocate no per-caller state.
 */

export interface TokenBucketOptions {
  readonly capacity: number;
  readonly refillIntervalMs: number;
  readonly now?: () => number;
}

export class TokenBucket {
  readonly #capacity: number;
  readonly #refillIntervalMs: number;
  readonly #now: () => number;
  #tokens: number;
  #lastRefillAt: number;

  constructor({ capacity, refillIntervalMs, now = Date.now }: TokenBucketOptions) {
    // Checked because this is exported: two `FAIL IF` clauses rest on the bound
    // it computes, and a `refillIntervalMs` of 0 divides to `Infinity` — a
    // bucket that refills fully on every call, which reads as working.
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

  /** Spend one token, returning `null` on success or the wait until the next one. */
  take(): number | null {
    const elapsed = Math.max(0, this.#now() - this.#lastRefillAt);
    const refill = Math.floor(elapsed / this.#refillIntervalMs);
    if (refill > 0) {
      this.#tokens = Math.min(this.#capacity, this.#tokens + refill);
      this.#lastRefillAt += refill * this.#refillIntervalMs;
    }
    if (this.#tokens > 0) {
      this.#tokens -= 1;
      return null;
    }
    // Reached only when `refill` was 0, so `#lastRefillAt` is unmoved and
    // `elapsed` is still the time standing against the next token.
    return Math.max(1, this.#refillIntervalMs - elapsed);
  }
}
