/**
 * A block of ids a host reserved for this page, so a create mints synchronously.
 * Refilled in the background below the low-water mark, so a burst of creates
 * stays ahead of the reservation round trip. Shared by the Workspace and
 * Surface id stores, which each choose what to mint when it is empty.
 *
 * Keep the pool small: the host numbers ids densely across launches, and the
 * ids a page holds when it exits are never handed out, so they are the gap a
 * launch leaves in the numbering, and a ref is the number. A burst that mints
 * more than the pool holds at once reserves its count first ({@link IdPool.minter}).
 */
export interface IdPool {
  /** Mint from `reserve`. Resolves once the first block is in hand. */
  install(reserve: (count: number) => Promise<string[]>): Promise<void>;
  /** Forget the installed host (tests). */
  reset(): void;
  /** Whether a host that mints ids is installed. */
  readonly installed: boolean;
  /** The next reserved id, or undefined when none is in hand. */
  take(): string | undefined;
  /**
   * A synchronous minter for a burst of `count` ids, all in hand once this
   * resolves: from the pool first, then reserved from the host, so a burst
   * larger than the pool never falls back. Past `count`, or with no host, it
   * returns `fallback()`.
   */
  minter(count: number, fallback: () => string): Promise<() => string>;
}

export function createIdPool(size: number, low: number, label: string): IdPool {
  const ids: string[] = [];
  let reserveIds: ((count: number) => Promise<string[]>) | null = null;
  let refilling: Promise<void> | null = null;

  function failed(error: unknown): void {
    console.error(`[${label}] the host did not reserve ids; using opaque ids until it does`, error);
  }

  function refill(): Promise<void> {
    if (!reserveIds || refilling) return refilling ?? Promise.resolve();
    const reserve = reserveIds;
    // Up to `size`, never past it: what the pool holds at exit is burned.
    const pending = reserve(Math.max(1, size - ids.length))
      .then((block) => { if (reserveIds === reserve) ids.push(...block); })
      .catch(failed)
      .finally(() => { if (refilling === pending) refilling = null; });
    refilling = pending;
    return pending;
  }

  function take(): string | undefined {
    const id = ids.shift();
    if (ids.length < low) void refill();
    return id;
  }

  return {
    install(reserve) {
      reserveIds = reserve;
      refilling = null;
      ids.length = 0;
      return refill();
    },
    reset() {
      reserveIds = null;
      refilling = null;
      ids.length = 0;
    },
    get installed() { return reserveIds !== null; },
    take,
    async minter(count, fallback) {
      const burst = ids.splice(0, count);
      // A host may hand out fewer than asked (both clamp a block), so ask
      // until the burst is whole or the host stops answering.
      const reserve = reserveIds;
      while (reserve && burst.length < count) {
        try {
          const block = await reserve(count - burst.length);
          if (reserve !== reserveIds || block.length === 0) break;
          burst.push(...block);
        } catch (error) {
          failed(error);
          break;
        }
      }
      if (ids.length < low) void refill();
      return () => burst.shift() ?? fallback();
    },
  };
}
