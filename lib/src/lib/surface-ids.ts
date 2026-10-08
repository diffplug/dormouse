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

const pool = createIdPool(64, 16, 'surface-ids');
let localSequence = 0;
/** Whether a Wall in this page holds an id; `wall-handles.ts` installs it, since
 *  this module sits below the components. */
let wallOwns: (id: string) => boolean = () => false;

export function setSurfaceIdWallOwnership(owns: (id: string) => boolean): void {
  wallOwns = owns;
}

/** Mint from `reserve`, which hands out ids numbered above `floor` — the highest
 *  `surface-<n>` this page restored. Resolves once the first block is in hand,
 *  so a Surface created after boot never carries an opaque id. */
export function installSurfaceIdPool(
  reserve: (count: number, floor: number) => Promise<string[]>,
  floor: number,
): Promise<void> {
  return pool.install((count) => reserve(count, floor));
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

/** A new Surface id. One a Session or Wall in this page already holds is
 *  skipped, and logged: a host's counter never produces one, but the page's
 *  own counter starts at `surface-1` whatever this page restored. */
export function mintSurfaceId(): string {
  for (;;) {
    const id = nextId();
    if (!registry.has(id) && !wallOwns(id)) return id;
    console.error(`[surface-ids] skipping ${id}, which is already in use`);
  }
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
