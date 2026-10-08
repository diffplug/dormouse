import { surfaceIdFor, surfaceIdNumber } from 'dor/protocol';
import { createIdPool } from './id-pool';
import type { PersistedSession } from './session-types';
import { registry } from './terminal-store';

/**
 * Surface ids (`docs/specs/transport.md` → "Surface ids"): `surface-<n>` off one
 * host counter, handed to this page in blocks so a Wall mints synchronously.
 * With no host installed (playground, Storybook, Pocket, tests) the page
 * counts on its own.
 */

// Small, so a launch burns at most 8 numbers (see `createIdPool`). Surfaces are
// created at the user's pace — a keystroke, a click, a `dor` process each — and
// a refill is one host round trip of a few ms, so refilling once 3 are gone
// keeps a quick run of creates ahead of it; a burst that mints more at once
// reserves through `surfaceIdMinter`.
const pool = createIdPool(8, 6, 'surface-ids');
let localSequence = 0;

/** Mint from `reserve`, which hands out ids numbered above `floor` — the highest
 *  `surface-<n>` this page restored. Resolves once the first block is in hand,
 *  so a Surface created after boot never carries an opaque id. */
export function installSurfaceIdPool(
  reserve: (count: number, floor: number) => Promise<string[]>,
  floor: number,
): Promise<void> {
  return pool.install((count) => reserve(count, floor));
}

/** Keep the page's own counter above `ids`, the Surfaces a restore brings
 *  back; a host's counter is above them already (the reservation's floor). */
export function seedSurfaceIds(ids: Iterable<string>): void {
  for (const id of ids) localSequence = Math.max(localSequence, surfaceIdNumber(id) ?? 0);
}

/** Back to the page's own counter, from `surface-1` (tests). */
export function resetSurfaceIdPool(): void {
  pool.reset();
  localSequence = 0;
}

function nextId(): string {
  if (!pool.installed) return surfaceIdFor(++localSequence);
  return pool.take() ?? `surface-${crypto.randomUUID()}`;
}

/** The first id from `next` no Session in this page already holds; a skipped
 *  one is logged, since neither counter should produce one. */
function mintFrom(next: () => string): string {
  for (;;) {
    const id = next();
    if (!registry.has(id)) return id;
    console.error(`[surface-ids] skipping ${id}, which is already in use`);
  }
}

/** A new Surface id. */
export function mintSurfaceId(): string {
  return mintFrom(nextId);
}

/** A synchronous minter for `count` Surfaces created at once (a Reopen remaps a
 *  whole Workspace or window), with every id in hand once it resolves, so a
 *  burst larger than the pool still mints numbered ids. */
export async function surfaceIdMinter(count: number): Promise<() => string> {
  const next = await pool.minter(count, nextId);
  return () => mintFrom(next);
}

/** The highest `surface-<n>` number among `sessions`' Surfaces, else 0. */
export function maxSurfaceNumber(sessions: Iterable<PersistedSession>): number {
  let max = 0;
  for (const session of sessions) {
    for (const { id } of [...session.panes, ...(session.doors ?? [])]) {
      max = Math.max(max, surfaceIdNumber(id) ?? 0);
    }
  }
  return max;
}
