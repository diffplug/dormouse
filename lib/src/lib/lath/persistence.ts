// The Lath persisted-layout wire format and its reader/writer (docs/specs/
// tiling-engine.md → "Persistence"). Plain data over the core model:
// `lathLayoutFromStore` snapshots the wall store into the on-disk blob, and
// `isLathPersistedLayout` recognizes one at the session read boundary
// (`session-restore.ts`). The engine (`lath-wall-engine.ts`) owns
// `serializeLayout`/`seed`, which call through here.

import { type LathTree, leaves, validate } from './model';
import { isRecord } from '../is-record';

/** Per-leaf presentation metadata, keyed by leaf id — the Pane props contract's
 *  "read side", owned live by the wall store's `leafMeta` map and serialized
 *  verbatim inside the persisted Lath layout. */
export type LeafMeta = {
  /** Body component key — `'terminal'` | `'browser'` | `'tool'`. Resolved through
   *  LathHost's body registry, which owns the live set. */
  component: string;
  /** Header component key — `'terminal'` | `'surface'` | `'tool'`. */
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
  // `leafMeta` also covers Doored leaves (the store stays their authority while they
  // are minimized), but the LAYOUT is the tree — a Door persists as its own row, so
  // keep only the leaves the tree actually places.
  const meta: Record<string, LeafMeta> = {};
  for (const id of leaves(snapshot.tree)) {
    const m = snapshot.leafMeta.get(id);
    if (m) meta[id] = m;
  }
  return { version: 1, tree: snapshot.tree, leafMeta: meta };
}

/** Validate the whole layout at the read boundary, before typed tree traversal. */
export function isLathPersistedLayout(blob: unknown): blob is LathPersistedLayout {
  if (!isRecord(blob) || blob.version !== 1 || validate(blob.tree).length > 0 || !isRecord(blob.leafMeta)) return false;
  const ids = new Set(leaves(blob.tree as LathTree));
  const entries = Object.entries(blob.leafMeta);
  if (entries.length !== ids.size) return false;
  return entries.every(([id, meta]) => ids.has(id) && isRecord(meta)
    && typeof meta.component === 'string' && typeof meta.tabComponent === 'string'
    && typeof meta.title === 'string' && (meta.params === undefined || isRecord(meta.params)));
}
