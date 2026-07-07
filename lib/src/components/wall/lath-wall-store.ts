// The Lath-side Wall store: headless state over the stage-1 core (docs/specs/
// tiling-engine.md → "Adapters; the HTML adapter (LathHost)", "Pane props contract").
// It owns the split tree plus a per-leaf metadata map and exposes a
// `useSyncExternalStore`-compatible snapshot. Every mutator applies exactly one
// pure core op; a rejected op (`ok: false`) commits nothing and returns the
// failure verbatim, so callers can distinguish "did nothing" from "changed".
//
// What lives here is *geometry + metadata only*: there is no selection, focus,
// mode, or activation anywhere in this file — those stay in the Wall, which wires
// itself to this store.

import {
  type Edge,
  type LathTree,
  type LeafId,
  type Rect,
  findLeafPath,
  leafTree,
  leaves,
  oppositeEdge,
} from '../../lib/lath/model';
import type { EnterFrom } from '../../lib/lath/animator';
import { type Direction, type LayoutOpts, autoEdge, neighbors } from '../../lib/lath/layout';
import {
  type DropTarget,
  type RestoreToken,
  insert,
  move,
  remove,
  replace,
  resize,
  restore,
  split,
  swap,
} from '../../lib/lath/ops';

/** Per-leaf presentation metadata, keyed by leaf id in the snapshot's `leafMeta`
 *  map. This is the state that today rides inside dockview's serialized panel
 *  blobs (the Pane props contract's "read side"). */
export type LeafMeta = {
  /** Body component key — `'terminal'` | `'browser'` (legacy `'iframe'` /
   *  `'agent-browser'` aliases are resolved to `'browser'` at conversion time and
   *  again at render time). */
  component: string;
  /** Header component key — `'terminal'` | `'surface'`. */
  tabComponent: string;
  /** Engine-tracked fallback title (live titles come from the terminal-state
   *  stores). Always a string in the snapshot. */
  title: string;
  params?: Record<string, unknown>;
};

/** An immutable view of the store. `getSnapshot` returns the same object identity
 *  until the next commit, as `useSyncExternalStore` requires. */
export type LathWallSnapshot = {
  tree: LathTree;
  leafMeta: ReadonlyMap<string, LeafMeta>;
  zoomedId: string | null;
  /** Monotonic; bumps on every commit (meta writes and zoom included) so effects
   *  can key off "something committed" without diffing the tree. */
  revision: number;
};

/** Where a new leaf lands: beside `refId` on `edge`. `null` (or a `refId` that is
 *  gone) means "beside the last leaf via `autoEdge`", or "become the root" when the
 *  tree is empty. */
export type AddLeafPosition = { refId: string; edge: Edge } | null;

export type LathWallStore = {
  /** `useSyncExternalStore` reader — stable identity between commits. */
  getSnapshot(): LathWallSnapshot;
  /** `useSyncExternalStore` subscriber — returns an unsubscribe. */
  subscribe(listener: () => void): () => void;

  /** Initial hydration: replace the tree and meta wholesale (clears zoom). */
  seed(tree: LathTree, meta: ReadonlyArray<readonly [LeafId, LeafMeta]>): void;

  /** Add `id` (with `meta`) beside `position.refId` on its edge, or beside the
   *  last leaf via `autoEdge`, or as the root of an empty tree. Rejects (`ok:
   *  false`, no commit) if `id` already exists or the underlying `split` fails. */
  addLeaf(id: LeafId, meta: LeafMeta, position: AddLeafPosition): { ok: boolean };

  /** Remove `id` and delete its meta. On success returns the core `RestoreToken`
   *  for the caller to persist on the resulting Door. */
  removeLeaf(id: LeafId): { ok: boolean; token: RestoreToken | null };

  /** Atomically swap `oldId` for `newId` in place, moving meta from the old id to
   *  the new one — the `dor iframe` replace-untouched-terminal case, with no
   *  transient add/remove states. */
  replaceLeaf(oldId: LeafId, newId: LeafId, meta: LeafMeta): { ok: boolean };

  /** Reinsert a removed leaf from its `token` (three-tier core `restore`), setting
   *  its meta. `opts.fallbackRef` is the live leaf the fallback tier splits beside;
   *  the store supplies its last layout geometry so that tier can `autoEdge`. */
  restoreLeaf(
    meta: LeafMeta,
    token: RestoreToken,
    opts?: { fallbackRef?: LeafId },
  ): { ok: boolean; tier: 'exact' | 'neighbor' | 'fallback' | null };

  /** Exchange two leaf identities. Meta stays keyed by id, so each leaf's title /
   *  params follow its id automatically — unlike dockview, which tracks titles on
   *  the panel and needs a companion `swapPanelTitles`; there is nothing to swap
   *  here. */
  swapLeaves(a: LeafId, b: LeafId): { ok: boolean };

  /** Move an existing leaf onto a hit-tested drop `target` (core `move`, one commit).
   *  Meta follows the id, so nothing else moves. Rejected op → no commit. */
  moveLeaf(id: LeafId, target: DropTarget): { ok: boolean };

  /** Insert a NEW leaf onto a hit-tested drop `target` (core `insert` at the default
   *  0.5 split), setting its meta — the Door drag-out reattach. Rejected op → no
   *  commit. */
  insertLeaf(id: LeafId, meta: LeafMeta, target: DropTarget): { ok: boolean };

  /** Commit a sash resize (one core `resize`) using the store's last reported
   *  geometry. Called once on pointerup; the live drag preview is LathHost-local.
   *  Rejects if no geometry has been reported yet or the op fails. */
  resizeBoundary(splitPath: number[], boundary: number, deltaPx: number): { ok: boolean };

  /** Meta write: set a leaf's fallback title. No-op if unchanged or absent. */
  setTitle(id: LeafId, title: string): void;
  /** Meta write: merge `patch` into a leaf's params. No-op if the leaf is absent. */
  updateParams(id: LeafId, patch: Record<string, unknown>): void;

  /** Presentation-only zoom target (the tree is untouched). No-op if unchanged. */
  setZoomed(id: LeafId | null): void;

  /** LathHost reports the rect + opts it renders with; the store keeps the latest
   *  to feed `restoreLeaf`, `resizeBoundary`, `neighborOf`, and `addLeaf`'s
   *  `autoEdge`. Not part of the snapshot — it drives queries, not rendering — so
   *  it never notifies. */
  setLayoutGeometry(rect: Rect, opts: LayoutOpts): void;

  /** Record the edge a soon-to-be-added leaf should enter from (drained at the next
   *  retarget). An explicit call always wins — the mutators derive a hint internally
   *  from the edge they commit, but only when none was pre-set for that id (e.g. the
   *  auto-spawn `'top-left'` policy override). Side state, never in the snapshot. */
  setEnterHint(id: LeafId, enterFrom: EnterFrom): void;
  /** Drain and return every pending enter hint (LathHost consumes these when it
   *  ingests a committed layout). */
  consumeEnterHints(): Map<string, EnterFrom>;

  /** Pre-order leaf ids of the current tree. */
  leafIds(): LeafId[];
  /** Whether `id` is a leaf in the current tree. */
  has(id: LeafId): boolean;
  /** Nearest neighbor of `id` in `direction` under the last reported geometry, or
   *  null (no neighbor, or no geometry yet). */
  neighborOf(id: LeafId, direction: Direction): LeafId | null;
  /** Aspect-ratio split edge for `id` under the last reported geometry (`autoEdge`);
   *  `'right'` when there is no geometry yet or the leaf is absent. Replaces
   *  `pickSplitDirection` on the Lath path. */
  autoEdgeFor(id: LeafId): Edge;
};

const EMPTY_TREE: LathTree = { root: null };

export function createLathWallStore(): LathWallStore {
  let snapshot: LathWallSnapshot = Object.freeze({
    tree: EMPTY_TREE,
    leafMeta: new Map<string, LeafMeta>(),
    zoomedId: null,
    revision: 0,
  });
  // Last geometry LathHost rendered with; drives queries, never part of a snapshot.
  let geometry: { rect: Rect; opts: LayoutOpts } | null = null;
  // Enter hints drained per retarget by LathHost. Side state, never in the snapshot.
  const enterHints = new Map<string, EnterFrom>();
  const listeners = new Set<() => void>();

  /** Derive an enter hint from the edge a mutator actually committed, unless an
   *  explicit `setEnterHint` already named this leaf (a policy override wins). The
   *  leaf grows FROM the boundary it shares with its reference — the opposite edge. */
  function deriveEnterHint(id: LeafId, placementEdge: Edge): void {
    if (enterHints.has(id)) return;
    enterHints.set(id, oppositeEdge(placementEdge));
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  /** Publish a new frozen snapshot (revision bumped) and notify. `leafMeta` is
   *  reused by identity when a commit does not touch meta, so pure tree ops never
   *  clone the map; meta-changing commits pass a freshly-built map. */
  function commit(next: {
    tree?: LathTree;
    leafMeta?: ReadonlyMap<string, LeafMeta>;
    zoomedId?: string | null;
  }): void {
    snapshot = Object.freeze({
      tree: next.tree ?? snapshot.tree,
      leafMeta: next.leafMeta ?? snapshot.leafMeta,
      zoomedId: next.zoomedId !== undefined ? next.zoomedId : snapshot.zoomedId,
      revision: snapshot.revision + 1,
    });
    notify();
  }

  function cloneMeta(): Map<string, LeafMeta> {
    return new Map(snapshot.leafMeta);
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    seed(tree, meta) {
      commit({ tree, leafMeta: new Map(meta), zoomedId: null });
    },

    addLeaf(id, meta, position) {
      const tree = snapshot.tree;

      // Empty tree: the new leaf becomes the root (there is no core op for
      // inserting into an empty tree — the Wall seeds it here).
      if (tree.root === null) {
        const m = cloneMeta();
        m.set(id, meta);
        commit({ tree: leafTree(id), leafMeta: m });
        return { ok: true };
      }

      let refId: LeafId | undefined;
      let edge: Edge;
      if (position && findLeafPath(tree, position.refId) !== null) {
        refId = position.refId;
        edge = position.edge;
      } else {
        const ids = leaves(tree);
        refId = ids[ids.length - 1];
        edge = refId !== undefined && geometry
          ? autoEdge(tree, geometry.rect, refId, geometry.opts)
          : 'right';
      }
      if (refId === undefined) return { ok: false };

      const r = split(tree, refId, edge, id);
      if (!r.ok) return { ok: false };
      // Enter from the boundary the split lands beside (opposite the placement edge) —
      // including the null-position `autoEdge` fallback, so those adds animate too.
      deriveEnterHint(id, edge);
      const m = cloneMeta();
      m.set(id, meta);
      commit({ tree: r.tree, leafMeta: m });
      return { ok: true };
    },

    removeLeaf(id) {
      const r = remove(snapshot.tree, id);
      if (!r.ok) return { ok: false, token: null };
      const m = cloneMeta();
      m.delete(id);
      // `zoomedId` always names a live leaf (a store invariant, like meta): clear it
      // when the leaf it named departs.
      commit({ tree: r.tree, leafMeta: m, ...(snapshot.zoomedId === id ? { zoomedId: null } : {}) });
      return { ok: true, token: r.token };
    },

    replaceLeaf(oldId, newId, meta) {
      const r = replace(snapshot.tree, oldId, newId);
      if (!r.ok) return { ok: false };
      const m = cloneMeta();
      m.delete(oldId);
      m.set(newId, meta);
      // A replace preserves the slot, so retarget a zoom that named the old leaf.
      commit({ tree: r.tree, leafMeta: m, ...(snapshot.zoomedId === oldId ? { zoomedId: newId } : {}) });
      return { ok: true };
    },

    restoreLeaf(meta, token, opts) {
      const r = restore(snapshot.tree, token, {
        fallbackRef: opts?.fallbackRef,
        rect: geometry?.rect,
        layoutOpts: geometry?.opts,
      });
      if (!r.ok) return { ok: false, tier: r.tier };
      // Enter from the boundary the door lands beside (opposite the token's edge). An
      // exact-tier restore may land on a different edge — acceptable; entry is cosmetic.
      deriveEnterHint(token.leafId, token.edge);
      const m = cloneMeta();
      m.set(token.leafId, meta);
      commit({ tree: r.tree, leafMeta: m });
      return { ok: true, tier: r.tier };
    },

    swapLeaves(a, b) {
      const r = swap(snapshot.tree, a, b);
      if (!r.ok) return { ok: false };
      // Meta is keyed by id and untouched by a swap, so reuse the same map.
      commit({ tree: r.tree });
      return { ok: true };
    },

    moveLeaf(id, target) {
      const r = move(snapshot.tree, id, target);
      if (!r.ok) return { ok: false };
      // Meta is keyed by id and untouched by a move, so reuse the same map.
      commit({ tree: r.tree });
      return { ok: true };
    },

    insertLeaf(id, meta, target) {
      const r = insert(snapshot.tree, id, target);
      if (!r.ok) return { ok: false };
      // A successful insert is always an edge target — enter from its opposite edge.
      if (target.kind === 'edge') deriveEnterHint(id, target.edge);
      const m = cloneMeta();
      m.set(id, meta);
      commit({ tree: r.tree, leafMeta: m });
      return { ok: true };
    },

    resizeBoundary(splitPath, boundary, deltaPx) {
      if (!geometry) return { ok: false };
      const r = resize(snapshot.tree, splitPath, boundary, deltaPx, geometry.rect, geometry.opts);
      if (!r.ok) return { ok: false };
      commit({ tree: r.tree });
      return { ok: true };
    },

    setTitle(id, title) {
      const cur = snapshot.leafMeta.get(id);
      if (!cur || cur.title === title) return;
      const m = cloneMeta();
      m.set(id, { ...cur, title });
      commit({ leafMeta: m });
    },

    updateParams(id, patch) {
      const cur = snapshot.leafMeta.get(id);
      if (!cur) return;
      const m = cloneMeta();
      m.set(id, { ...cur, params: { ...(cur.params ?? {}), ...patch } });
      commit({ leafMeta: m });
    },

    setZoomed(id) {
      if (snapshot.zoomedId === id) return;
      commit({ zoomedId: id });
    },

    setLayoutGeometry(rect, opts) {
      geometry = { rect, opts };
    },

    setEnterHint(id, enterFrom) {
      enterHints.set(id, enterFrom);
    },
    consumeEnterHints() {
      const drained = new Map(enterHints);
      enterHints.clear();
      return drained;
    },

    leafIds: () => leaves(snapshot.tree),
    has: (id) => findLeafPath(snapshot.tree, id) !== null,
    neighborOf(id, direction) {
      if (!geometry) return null;
      return neighbors(snapshot.tree, geometry.rect, id, direction, geometry.opts);
    },
    autoEdgeFor(id) {
      if (!geometry) return 'right';
      return autoEdge(snapshot.tree, geometry.rect, id, geometry.opts);
    },
  };
}
