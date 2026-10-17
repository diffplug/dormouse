/**
 * The page's minter for one kind of numbered id (`surface:<n>`,
 * `workspace:<n>`): a block of ids a host reserved for this page, so a create
 * mints synchronously, refilled in the background below the low-water mark so a
 * burst of creates stays ahead of the reservation round trip. With no host
 * installed the page counts on its own; with one installed and its pool empty,
 * it mints `<prefix><uuid>`. Either way it skips an id the page already holds.
 *
 * Keep the pool small: the host numbers ids densely across launches, and the
 * ids a page holds when it exits are never handed out, so they are the gap a
 * launch leaves in the numbering, and a `dor` handle is the number. A burst that mints
 * more than the pool holds at once reserves the difference first ({@link IdPool.minter}).
 */
export interface IdPool {
  /** Mint from `reserve`, starting from `first` when the caller already
   *  asked for the first block. Resolves once the first block is in hand. */
  install(reserve: (count: number) => Promise<string[]>, first?: Promise<string[]>): Promise<void>;
  /** Forget the installed host, and count in the page from the start (tests). */
  reset(): void;
  /** Whether a host that mints ids is installed. */
  readonly installed: boolean;
  /** A new id. */
  mint(): string;
  /** Keep the page's own counter above `n`; a no-op while a host mints. */
  seed(n: number): void;
  /**
   * A synchronous minter for a burst of `count` ids, all in hand once this
   * resolves. What the pool holds serves the burst; the host reserves the rest
   * first, apart from the pool, so a burst larger than the pool never falls
   * back, and a create that lands while it awaits still finds the pool whole.
   * Past `count`, it mints as {@link IdPool.mint} does.
   */
  minter(count: number): Promise<() => string>;
}

export interface IdPoolOptions {
  /** How many ids the pool holds once full. */
  size: number;
  /** Refill once the pool holds fewer than this. */
  low: number;
  label: string;
  /** The id numbered `n`, or a fallback's `<prefix><uuid>`. */
  idFor(n: number | string): string;
  /** The page's own counter mints above this. */
  localStart: number;
  /** Whether the page already holds `id`. */
  inUse(id: string): boolean;
  /** Log a skipped id: neither counter should produce one. */
  logSkips: boolean;
}

export function createIdPool({ size, low, label, idFor, localStart, inUse, logSkips }: IdPoolOptions): IdPool {
  const ids: string[] = [];
  let reserveIds: ((count: number) => Promise<string[]>) | null = null;
  let refilling: Promise<void> | null = null;
  let localSequence = localStart;

  function failed(error: unknown): void {
    console.error(`[${label}] the host did not reserve ids; using opaque ids until it does`, error);
  }

  /** Add `block` once it lands, unless another host was installed since. */
  function fill(reserve: (count: number) => Promise<string[]>, block: Promise<string[]>): Promise<void> {
    const pending = block
      .then((reserved) => { if (reserveIds === reserve) ids.push(...reserved); })
      .catch(failed)
      .finally(() => { if (refilling === pending) refilling = null; });
    refilling = pending;
    return pending;
  }

  function refill(): Promise<void> {
    if (!reserveIds || refilling) return refilling ?? Promise.resolve();
    // Up to `size`, never past it: what the pool holds at exit is burned.
    return fill(reserveIds, reserveIds(Math.max(1, size - ids.length)));
  }

  /** The next reserved id, or undefined when none is in hand. */
  function take(): string | undefined {
    const id = ids.shift();
    if (ids.length < low) void refill();
    return id;
  }

  function next(): string {
    if (!reserveIds) return idFor(++localSequence);
    return take() ?? idFor(crypto.randomUUID());
  }

  /** The first id from `source` the page does not already hold. */
  function unused(source: () => string): string {
    for (;;) {
      const id = source();
      if (!inUse(id)) return id;
      if (logSkips) console.error(`[${label}] skipping ${id}, which is already in use`);
    }
  }

  return {
    install(reserve, first) {
      reserveIds = reserve;
      refilling = null;
      ids.length = 0;
      return first ? fill(reserve, first) : refill();
    },
    reset() {
      reserveIds = null;
      refilling = null;
      ids.length = 0;
      localSequence = localStart;
    },
    get installed() { return reserveIds !== null; },
    mint: () => unused(next),
    seed(n) {
      localSequence = Math.max(localSequence, n);
    },
    async minter(count) {
      const reserved: string[] = [];
      // A host may hand out fewer than asked (both clamp a block), so ask
      // until the pool can cover the rest or the host stops answering.
      const reserve = reserveIds;
      while (reserve && reserve === reserveIds && count - reserved.length > ids.length) {
        try {
          const block = await reserve(count - reserved.length - ids.length);
          if (reserve !== reserveIds || block.length === 0) break;
          reserved.push(...block);
        } catch (error) {
          failed(error);
          break;
        }
      }
      const pooled: string[] = [];
      while (reserved.length + pooled.length < count && ids.length > 0) pooled.push(take()!);
      const burst = [...pooled, ...reserved];
      return () => unused(() => burst.shift() ?? next());
    },
  };
}
