import { maxSurfaceIdNumber, surfaceIdFor } from 'dor/protocol';
import { createIdPool } from './id-pool';
import { sessionSurfaceIds, type PersistedSession } from './session-types';
import { registry } from './terminal-store';
import { isWorkspaceSurface } from './workspace-surfaces';

/**
 * Surface ids (`docs/specs/transport.md` → "Surface ids"): `surface:<n>` off one
 * host counter, handed to this page in blocks so a Wall mints synchronously.
 * With no host installed (playground, Storybook, Pocket, tests) the page
 * counts on its own.
 */

export const SURFACE_ID_POOL_SIZE = 8;
// Small, so a launch burns at most 8 numbers (see `createIdPool`). Surfaces are
// created at the user's pace — a keystroke, a click, a `dor` process each — and
// a refill is one host round trip of a few ms, so refilling once 3 are gone
// keeps a quick run of creates ahead of it, where a lower mark left a run
// outpacing the refill with opaque ids for life; a burst that mints more at
// once reserves through `surfaceIdMinter`.
const pool = createIdPool({
  size: SURFACE_ID_POOL_SIZE,
  low: 6,
  label: 'surface-ids',
  idFor: surfaceIdFor,
  localStart: 0,
  // Every Surface the page holds: a terminal's Session (a helper's too, which
  // has no Lath leaf), and any kind of Surface a mounted Wall publishes.
  inUse: (id) => registry.has(id) || isWorkspaceSurface(id),
  logSkips: true,
});

/** Mint from `reserve`, which hands out ids numbered above `floor` — the highest
 *  `surface:<n>` this page restored — starting from `first` when the caller
 *  already asked for a {@link SURFACE_ID_POOL_SIZE} block. Resolves once the
 *  first block is in hand, so a Surface created after boot never carries an
 *  opaque id. */
export function installSurfaceIdPool(
  reserve: (count: number, floor: number) => Promise<string[]>,
  floor: number,
  first?: Promise<string[]>,
): Promise<void> {
  return pool.install((count) => reserve(count, floor), first);
}

/** Keep the page's own counter above `floor`, the highest `surface:<n>` a
 *  restore brings back; a host's counter is above it already (the
 *  reservation's floor). The in-use skip alone would not do: a restore mints
 *  before its Wall publishes its Surfaces, and every skip is logged as a fault. */
export function seedSurfaceIds(floor: number): void {
  pool.seed(floor);
}

/** Back to the page's own counter, from `surface:1` (tests). */
export function resetSurfaceIdPool(): void {
  pool.reset();
}

/** A new Surface id. */
export function mintSurfaceId(): string {
  return pool.mint();
}

/** A synchronous minter for `count` Surfaces created at once (a Reopen remaps a
 *  whole Workspace or window), with every id in hand once it resolves, so a
 *  burst larger than the pool still mints numbered ids. */
export function surfaceIdMinter(count: number): Promise<() => string> {
  return pool.minter(count);
}

/** The highest `surface:<n>` number among `sessions`' Surfaces, else 0. */
export function maxSurfaceNumber(sessions: Iterable<PersistedSession>): number {
  let max = 0;
  for (const session of sessions) max = Math.max(max, maxSurfaceIdNumber(sessionSurfaceIds(session)));
  return max;
}
