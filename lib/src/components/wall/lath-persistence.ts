// The Lath persisted-layout wire format and its reader/writer (docs/specs/
// tiling-engine.md → "Persistence and migration"). Persistence is an engine
// concern layered over the store: `lathLayoutFromStore` snapshots the store into
// the on-disk blob, and `isLathPersistedLayout` recognizes one on restore. The
// legacy dockview reader (`lath-dockview-convert.ts`) imports the type; the engine
// (`lath-wall-engine.ts`) owns `serializeLayout`/`seed`, which call through here.

import type { LathTree } from '../../lib/lath/model';
import type { LeafMeta } from './lath-wall-store';

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
