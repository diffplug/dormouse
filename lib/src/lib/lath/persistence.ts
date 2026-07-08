// The Lath persisted-layout wire format and its reader/writer (docs/specs/
// tiling-engine.md → "Persistence"). Plain data over the core model:
// `lathLayoutFromStore` snapshots the wall store into the on-disk blob, and
// `isLathPersistedLayout` recognizes one at the session read boundary
// (`session-restore.ts`). The engine (`lath-wall-engine.ts`) owns
// `serializeLayout`/`seed`, which call through here.

import type { LathTree } from './model';

/** Per-leaf presentation metadata, keyed by leaf id — the Pane props contract's
 *  "read side", owned live by the wall store's `leafMeta` map and serialized
 *  verbatim inside the persisted Lath layout. */
export type LeafMeta = {
  /** Body component key — `'terminal'` | `'browser'`. */
  component: string;
  /** Header component key — `'terminal'` | `'surface'`. */
  tabComponent: string;
  /** Engine-tracked fallback title (live titles come from the terminal-state
   *  stores). Always a string in the snapshot. */
  title: string;
  params?: Record<string, unknown>;
};

/** The Lath persisted layout — the tree is its own wire format; `leafMeta` carries
 *  the per-leaf `{ component, tabComponent, title, params }`. */
export type LathPersistedLayout = {
  version: 1;
  tree: LathTree;
  leafMeta: Record<string, LeafMeta>;
};

/** Serialize a store snapshot to the Lath persisted layout (trivial — the tree is
 *  already the wire format). */
export function lathLayoutFromStore(snapshot: {
  tree: LathTree;
  leafMeta: ReadonlyMap<string, LeafMeta>;
}): LathPersistedLayout {
  return { version: 1, tree: snapshot.tree, leafMeta: Object.fromEntries(snapshot.leafMeta) };
}

/** Whether a restored blob is a well-formed Lath persisted layout (the tree's own
 *  validity is checked separately at seed time). */
export function isLathPersistedLayout(blob: unknown): blob is LathPersistedLayout {
  if (!blob || typeof blob !== 'object') return false;
  const b = blob as { version?: unknown; tree?: unknown; leafMeta?: unknown };
  if (b.version !== 1) return false;
  if (!b.tree || typeof b.tree !== 'object' || !('root' in (b.tree as object))) return false;
  return !!b.leafMeta && typeof b.leafMeta === 'object';
}
