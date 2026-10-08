/**
 * A block of ids a host reserved for this page, so a create mints synchronously.
 * Refilled in the background below the low-water mark, so a burst of creates
 * stays ahead of the reservation round trip. Shared by the Workspace and
 * Surface id stores, which each choose what to mint when it is empty.
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
}

export function createIdPool(size: number, low: number, label: string): IdPool {
  const ids: string[] = [];
  let reserveIds: ((count: number) => Promise<string[]>) | null = null;
  let refilling: Promise<void> | null = null;

  function refill(): Promise<void> {
    if (!reserveIds || refilling) return refilling ?? Promise.resolve();
    const reserve = reserveIds;
    const pending = reserve(size)
      .then((block) => { if (reserveIds === reserve) ids.push(...block); })
      .catch((error: unknown) => {
        console.error(`[${label}] the host did not reserve ids; using opaque ids until it does`, error);
      })
      .finally(() => { if (refilling === pending) refilling = null; });
    refilling = pending;
    return pending;
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
    take() {
      const id = ids.shift();
      if (ids.length < low) void refill();
      return id;
    },
  };
}
