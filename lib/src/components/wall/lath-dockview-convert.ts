// The dockview ↔ Lath layout-format boundary (docs/specs/tiling-engine.md →
// "Persistence and migration"). This is the ONLY new Lath module allowed to touch
// dockview types, and only as type-only imports — it is the seam. Both directions
// exist because, while the `dormouse.flags.lath` flag lives, saves dual-write both
// formats (so flipping the flag never loses a layout) and the legacy reader
// migrates pre-Lath `SerializedDockview` blobs.
//
// dockview's serialized grid stores orientation only at the root (`grid.orientation`)
// and *alternates it per depth*: a branch node lays its children along its own
// orientation, and its child branches take the orthogonal orientation (verified
// against dockview-core's `_deserializeNode`, which recurses with `orthogonal(o)`).
// A HORIZONTAL branch lays children left→right → a Lath `'row'` split; VERTICAL →
// `'col'`. Because Lath's `normalize` forbids a split directly containing a
// same-direction split, a normalized Lath tree's dirs already strictly alternate by
// depth, so the two models line up level-for-level.
//
// Type note: dockview-core does not re-export `GroupPanelViewState` (the leaf group
// state) from its public surface, so it is modelled locally as `GroupState`;
// `SerializedDockview` / `SerializedGridObject` / `GroupviewPanelState` come through
// fine. `grid.orientation` is a string enum whose members equal their names
// (`"HORIZONTAL"` / `"VERTICAL"`), so it is compared/emitted as those literals and
// the finished blob is cast to `SerializedDockview` (avoiding a runtime enum import).

import type {
  SerializedDockview,
  SerializedGridObject,
  GroupviewPanelState,
} from 'dockview-react';
import { type LathChild, type LathNode, type LathTree, leaves, normalize, validate } from '../../lib/lath/model';
import { cumulativeRound } from '../../lib/lath/layout';
import type { LeafMeta } from './lath-wall-store';

/** The Lath persisted layout — the tree is its own wire format; `leafMeta` carries
 *  the per-leaf `{ component, tabComponent, title, params }` that today rides inside
 *  dockview panel blobs. */
export type LathPersistedLayout = {
  version: 1;
  tree: LathTree;
  leafMeta: Record<string, LeafMeta>;
};

/** Leaf group state (dockview's un-exported `GroupPanelViewState`), modelled locally. */
type GroupState = { views: string[]; activeView?: string; id: string };

type Orientation = 'HORIZONTAL' | 'VERTICAL';

const DEFAULT_SIZE_HINT = { width: 1000, height: 800 } as const;

function orthogonal(o: Orientation): Orientation {
  return o === 'HORIZONTAL' ? 'VERTICAL' : 'HORIZONTAL';
}

function dirOf(o: Orientation): 'row' | 'col' {
  return o === 'HORIZONTAL' ? 'row' : 'col';
}

function orientationOf(dir: 'row' | 'col'): Orientation {
  return dir === 'row' ? 'HORIZONTAL' : 'VERTICAL';
}

// --- component / tab kind aliasing (matches Wall.tsx's `components` table) ---

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

function metaFromPanel(panel: GroupviewPanelState | undefined): LeafMeta {
  const component = componentKind(panel?.contentComponent);
  return {
    component,
    tabComponent: tabKind(component, panel?.tabComponent),
    title: typeof panel?.title === 'string' ? panel.title : '',
    // `params` is preserved verbatim (renderMode, url, session, …).
    params: panel?.params && typeof panel.params === 'object' ? { ...panel.params } : undefined,
  };
}

// --- dockview → Lath (legacy loader; defensive against any malformed blob) ---

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
  obj: SerializedGridObject<GroupState>,
  orientation: Orientation,
  panels: Record<string, GroupviewPanelState>,
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
    const raw = Array.isArray(obj.data) ? (obj.data as SerializedGridObject<GroupState>[]) : [];
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
    const dv = blob as SerializedDockview;
    const grid = dv.grid;
    if (!grid || typeof grid !== 'object' || grid.root == null || typeof grid.root !== 'object') return null;
    const orientation: Orientation = grid.orientation === 'VERTICAL' ? 'VERTICAL' : 'HORIZONTAL';
    const panels = (dv.panels && typeof dv.panels === 'object' ? dv.panels : {}) as Record<string, GroupviewPanelState>;

    const leafMeta: Record<string, LeafMeta> = {};
    const converted = convertObj(grid.root as SerializedGridObject<GroupState>, orientation, panels, leafMeta);
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

// --- Lath → persisted / Lath → dockview ---

/** Serialize a store snapshot to the Lath persisted layout (trivial — the tree is
 *  already the wire format). */
export function lathLayoutFromStore(snapshot: {
  tree: LathTree;
  leafMeta: ReadonlyMap<string, LeafMeta>;
}): LathPersistedLayout {
  return { version: 1, tree: snapshot.tree, leafMeta: Object.fromEntries(snapshot.leafMeta) };
}

/** Build a serialized grid object for a Lath node. `size` is the node's extent along
 *  its PARENT split's axis (proportional to its weight); dockview re-normalizes on
 *  layout, so absolute magnitudes only need to preserve sibling ratios. A split's own
 *  children are scaled into the sizeHint dimension for that split's axis via
 *  cumulative rounding. `nextGroupId` mints per-call group ids. */
function buildObj(
  node: LathNode,
  size: number | undefined,
  sizeHint: { width: number; height: number },
  nextGroupId: () => string,
): SerializedGridObject<GroupState> {
  if (node.kind === 'leaf') {
    // A single-view group; `activeView` is that lone view.
    return {
      type: 'leaf',
      data: { id: nextGroupId(), views: [node.id], activeView: node.id },
      ...(size !== undefined ? { size } : {}),
    };
  }
  const axisDim = node.dir === 'row' ? sizeHint.width : sizeHint.height;
  // Sum is always 1 on a valid tree; the `|| 1` only guards a degenerate all-zero split.
  const sum = node.children.reduce((s, c) => s + c.weight, 0) || 1;
  const childSizes = cumulativeRound(node.children.map((c) => (c.weight / sum) * axisDim), axisDim);
  const data = node.children.map((c, i) => buildObj(c.node, childSizes[i], sizeHint, nextGroupId));
  return { type: 'branch', data, ...(size !== undefined ? { size } : {}) };
}

/** Convert a Lath layout to a `SerializedDockview` blob (the reverse of
 *  `dockviewLayoutToLath`). A single-leaf or leaf-rooted tree is wrapped so
 *  `grid.root.type` is `'branch'` (dockview requires it). Browser panes get
 *  `renderer: 'always'` — matching what live dockview serializes for every browser
 *  surface today (`rendererForParams` in Wall.tsx always returns `'always'`). */
export function lathToDockviewLayout(
  layout: LathPersistedLayout,
  sizeHint: { width: number; height: number } = DEFAULT_SIZE_HINT,
): SerializedDockview {
  const panels: Record<string, GroupviewPanelState> = {};
  for (const [id, meta] of Object.entries(layout.leafMeta)) {
    const component = componentKind(meta.component);
    panels[id] = {
      id,
      contentComponent: meta.component,
      tabComponent: meta.tabComponent,
      ...(meta.title ? { title: meta.title } : {}),
      ...(component === 'browser' ? { renderer: 'always' as const } : {}),
      ...(meta.params ? { params: { ...meta.params } } : {}),
    };
  }

  // Group-id counter is local so a call produces deterministic ids from 0.
  let groupCounter = 0;
  const nextGroupId = (): string => `lath-group-${(groupCounter++).toString(36)}`;

  const root = layout.tree.root;
  const orientation: Orientation = root && root.kind === 'split' ? orientationOf(root.dir) : 'HORIZONTAL';

  let gridRoot: SerializedGridObject<GroupState>;
  if (root === null) {
    gridRoot = { type: 'branch', data: [], size: sizeHint.width };
  } else if (root.kind === 'split') {
    gridRoot = buildObj(root, undefined, sizeHint, nextGroupId);
    // Root carries its cross-axis extent as `size` (mirrors dockview's serialize).
    gridRoot.size = orientation === 'HORIZONTAL' ? sizeHint.height : sizeHint.width;
  } else {
    // Leaf-rooted tree: wrap in a single-child branch so the root is a branch.
    const mainDim = orientation === 'HORIZONTAL' ? sizeHint.width : sizeHint.height;
    gridRoot = {
      type: 'branch',
      data: [buildObj(root, mainDim, sizeHint, nextGroupId)],
      size: orientation === 'HORIZONTAL' ? sizeHint.height : sizeHint.width,
    };
  }

  // `activeView` per group is set in buildObj (single-view groups); `activeGroup`
  // points at the first group so a round-tripped blob reads like a live one.
  const activeGroup = findFirstGroupId(gridRoot);

  const blob = {
    grid: {
      root: gridRoot,
      width: sizeHint.width,
      height: sizeHint.height,
      orientation,
    },
    panels,
    ...(activeGroup ? { activeGroup } : {}),
  };
  return blob as unknown as SerializedDockview;
}

/** First leaf group's id in DOM order (for `activeGroup`). */
function findFirstGroupId(obj: SerializedGridObject<GroupState>): string | null {
  if (obj.type === 'leaf') return (obj.data as GroupState).id;
  for (const child of obj.data as SerializedGridObject<GroupState>[]) {
    const id = findFirstGroupId(child);
    if (id) return id;
  }
  return null;
}
