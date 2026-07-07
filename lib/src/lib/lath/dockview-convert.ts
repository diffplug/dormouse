// The legacy dockview → Lath layout upgrade reader (docs/specs/tiling-engine.md →
// "Persistence and migration"). Lath is the sole layout format Dormouse writes; this
// module exists only to migrate a `SerializedDockview` blob persisted by a pre-Lath
// build one-way into a Lath tree, once, at the session read boundary
// (`session-restore.ts`'s `persistedLathLayout`). It models the serialized dockview
// shape with LOCAL structural types (no dockview dependency).
//
// dockview's serialized grid stores orientation only at the root (`grid.orientation`)
// and *alternates it per depth*: a branch node lays its children along its own
// orientation, and its child branches take the orthogonal orientation. A HORIZONTAL
// branch lays children left→right → a Lath `'row'` split; VERTICAL → `'col'`. Because
// Lath's `normalize` forbids a split directly containing a same-direction split, a
// normalized Lath tree's dirs already strictly alternate by depth, so the two models
// line up level-for-level.

import { type LathChild, type LathNode, type LathTree, leaves, normalize, validate } from './model';
import type { LathPersistedLayout, LeafMeta } from './persistence';

type Orientation = 'HORIZONTAL' | 'VERTICAL';

// --- local structural models of the serialized dockview shape (read-only) ---

/** A dockview leaf group's state (its un-exported `GroupPanelViewState`). */
type GroupState = { views: string[]; activeView?: string; id: string };

/** One serialized grid object: a leaf group or a branch of them. */
type GridNodeLike = { type?: string; data?: unknown; size?: number };

/** The per-panel state in a serialized blob's flat `panels` map. */
type PanelStateLike = {
  id?: string;
  contentComponent?: string;
  tabComponent?: string;
  title?: unknown;
  params?: unknown;
};

/** A serialized dockview layout blob (the subset the migration reads). */
type SerializedDockviewLike = {
  grid?: { root?: unknown; orientation?: unknown };
  panels?: Record<string, PanelStateLike>;
};

function orthogonal(o: Orientation): Orientation {
  return o === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL';
}

function dirOf(o: Orientation): 'row' | 'col' {
  return o === 'HORIZONTAL' ? 'row' : 'col';
}

// --- component / tab kind aliasing (matches the LathHost component tables) ---

/** Normalize a dockview `contentComponent` to a Lath body key: the legacy `iframe`
 *  / `agent-browser` names and `browser` all collapse to `'browser'`; everything
 *  else (and absence) is a terminal. */
function componentKind(contentComponent: string | undefined): 'terminal' | 'browser' {
  return contentComponent === 'browser' ||
    contentComponent === 'iframe' ||
    contentComponent === 'agent-browser'
    ? 'browser'
    : 'terminal';
}

/** Resolve the header key: an explicit `terminal` / `surface` wins; otherwise it
 *  defaults by body kind (browser → `surface`, terminal → `terminal`). */
function tabKind(component: 'terminal' | 'browser', tabComponent: string | undefined): string {
  if (tabComponent === 'terminal' || tabComponent === 'surface') return tabComponent;
  return component === 'browser' ? 'surface' : 'terminal';
}

function metaFromPanel(panel: PanelStateLike | undefined): LeafMeta {
  const component = componentKind(panel?.contentComponent);
  return {
    component,
    tabComponent: tabKind(component, panel?.tabComponent),
    title: typeof panel?.title === 'string' ? panel.title : '',
    // `params` is preserved verbatim (renderMode, url, session, …).
    params: panel?.params && typeof panel.params === 'object' ? { ...(panel.params as Record<string, unknown>) } : undefined,
  };
}

// --- dockview → Lath (defensive against any malformed blob) ---

/** Weights from sibling `size` values, normalized to sum 1. If any size is missing
 *  or non-positive the whole group falls back to equal weights — keeping every
 *  weight strictly positive (the Lath invariant) rather than emitting a zero. */
function weightsFromSizes(sizes: Array<number | undefined>): number[] {
  const n = sizes.length;
  const allPositive = sizes.every((s) => typeof s === 'number' && s > 0);
  if (!allPositive) return new Array<number>(n).fill(1 / n);
  const sum = (sizes as number[]).reduce((a, b) => a + b, 0);
  return (sizes as number[]).map((s) => s / sum);
}

/** Convert one serialized grid object (leaf group or branch) at a known depth
 *  orientation into a Lath node, appending each view's meta into `leafMeta`.
 *  Returns null for an empty subtree; throws are caught by the top-level loader. */
function convertObj(
  obj: GridNodeLike | null | undefined,
  orientation: Orientation,
  panels: Record<string, PanelStateLike>,
  leafMeta: Record<string, LeafMeta>,
): LathNode | null {
  if (obj == null || typeof obj !== 'object') return null;

  if (obj.type === 'leaf') {
    const data = obj.data as GroupState;
    const views = Array.isArray(data?.views) ? data.views.filter((v): v is string => typeof v === 'string') : [];
    if (views.length === 0) return null;
    for (const viewId of views) leafMeta[viewId] = metaFromPanel(panels[viewId]);
    if (views.length === 1) return { kind: 'leaf', id: views[0] };
    // Dormouse never tab-stacks; a multi-view group degrades to an even split
    // along the branch axis at this depth (one Lath leaf per view).
    const children: LathChild[] = views.map((id) => ({ node: { kind: 'leaf', id }, weight: 1 / views.length }));
    return { kind: 'split', dir: dirOf(orientation), children };
  }

  if (obj.type === 'branch') {
    const raw = Array.isArray(obj.data) ? (obj.data as GridNodeLike[]) : [];
    const converted = raw.map((child) => ({
      node: convertObj(child, orthogonal(orientation), panels, leafMeta),
      size: typeof child?.size === 'number' ? child.size : undefined,
    }));
    const kept = converted.filter((c): c is { node: LathNode; size: number | undefined } => c.node !== null);
    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0].node;
    const weights = weightsFromSizes(kept.map((k) => k.size));
    const children: LathChild[] = kept.map((k, i) => ({ node: k.node, weight: weights[i] }));
    return { kind: 'split', dir: dirOf(orientation), children };
  }

  return null;
}

/** Migrate a legacy `SerializedDockview` blob to a Lath layout, or null if it is not
 *  a usable dockview blob (callers fall back to fresh panes). The built tree is run
 *  through `normalize` + `validate`; a tree that still fails validation returns null. */
export function dockviewLayoutToLath(blob: unknown): LathPersistedLayout | null {
  try {
    if (blob == null || typeof blob !== 'object') return null;
    const dv = blob as SerializedDockviewLike;
    const grid = dv.grid;
    if (!grid || typeof grid !== 'object' || grid.root == null || typeof grid.root !== 'object') return null;
    const orientation: Orientation = grid.orientation === 'VERTICAL' ? 'VERTICAL' : 'HORIZONTAL';
    const panels = (dv.panels && typeof dv.panels === 'object' ? dv.panels : {}) as Record<string, PanelStateLike>;

    const leafMeta: Record<string, LeafMeta> = {};
    const converted = convertObj(grid.root as GridNodeLike, orientation, panels, leafMeta);
    // A blob that converts to nothing usable (bad node types, empty groups, an
    // empty grid) is treated as malformed — a real dockview layout always has ≥1
    // pane, and the caller falls back to fresh panes on null.
    if (converted === null) return null;
    const normalized = normalize(converted);
    if (normalized === null) return null;
    const tree: LathTree = { root: normalized };

    const errors = validate(tree);
    if (errors.length > 0) return null;

    // Drop meta for any view that did not survive into the tree (defensive).
    const live = new Set(leaves(tree));
    for (const id of Object.keys(leafMeta)) if (!live.has(id)) delete leafMeta[id];

    return { version: 1, tree, leafMeta };
  } catch {
    return null;
  }
}
