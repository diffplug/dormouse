import type { PersistedSession } from './session-types';

/**
 * Surface ids (`docs/specs/transport.md` → "Surface ids"): `surface-<n>` off one
 * host counter, handed to this page in blocks so a Wall mints synchronously.
 * With no host installed (playground, Storybook, Pocket, tests) the page
 * counts on its own.
 */

// A block this size, refilled this early, keeps a burst of splits ahead of the
// reservation round-trip; an exhausted pool mints an opaque UUID id.
const POOL_SIZE = 64;
const POOL_LOW = 16;

const pool: string[] = [];
let reserveIds: ((count: number, floor: number) => Promise<string[]>) | null = null;
let restoredFloor = 0;
let refilling: Promise<void> | null = null;
let localSequence = 0;

function refill(): Promise<void> {
  if (!reserveIds || refilling) return refilling ?? Promise.resolve();
  const reserve = reserveIds;
  const pending = reserve(POOL_SIZE, restoredFloor)
    .then((ids) => { if (reserveIds === reserve) pool.push(...ids); })
    .catch((error: unknown) => {
      console.error('[surface-ids] the host did not reserve Surface ids; using opaque ids until it does', error);
    })
    .finally(() => { if (refilling === pending) refilling = null; });
  refilling = pending;
  return pending;
}

/** Mint from `reserve`, which hands out ids numbered above `floor` — the highest
 *  `surface-<n>` this page restored. Resolves once the first block is in hand,
 *  so a Surface created after boot never carries an opaque id. */
export function installSurfaceIdPool(
  reserve: (count: number, floor: number) => Promise<string[]>,
  floor: number,
): Promise<void> {
  reserveIds = reserve;
  restoredFloor = floor;
  refilling = null;
  pool.length = 0;
  return refill();
}

/** Back to the page's own counter, from `surface-1` (tests). */
export function resetSurfaceIdPool(): void {
  reserveIds = null;
  restoredFloor = 0;
  refilling = null;
  pool.length = 0;
  localSequence = 0;
}

function nextId(): string {
  if (!reserveIds) return `surface-${++localSequence}`;
  const reserved = pool.shift();
  if (pool.length < POOL_LOW) void refill();
  return reserved ?? `surface-${crypto.randomUUID()}`;
}

/** A new Surface id. `taken` names ids already live here; one is skipped, and
 *  logged, since the counter should never have produced it. */
export function mintSurfaceId(taken?: (id: string) => boolean): string {
  for (;;) {
    const id = nextId();
    if (!taken?.(id)) return id;
    console.error(`[surface-ids] skipping ${id}, which is already in use`);
  }
}

/** The highest `surface-<n>` number among `sessions`' Surfaces, else 0. */
export function maxSurfaceNumber(sessions: Iterable<PersistedSession>): number {
  let max = 0;
  for (const session of sessions) {
    for (const { id } of [...session.panes, ...(session.doors ?? [])]) {
      const match = /^surface-(\d+)$/.exec(id);
      if (match) max = Math.max(max, Number(match[1]));
    }
  }
  return max;
}
