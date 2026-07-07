// The Wall-facing Lath engine handle (docs/specs/tiling-engine.md → lath-rollout
// stage 2). Wraps the stage-2b headless store (`lath-wall-store.ts`) with the
// conveniences Wall.tsx needs so each lath branch in Wall stays a one-liner:
// tree pre-order + meta reads, the dor-direction ↔ Edge ↔ DoorDirection maps, the
// three-way hydration `seed`, and a legacy-Door → neighbor-tier token bridge.
//
// The engine holds NO selection/focus/mode/activation state — those stay in the
// Wall. This file is only wired up when `dormouse.flags.lath` is on; with the flag
// off `lath` is null and every Wall branch takes the untouched dockview path.

import {
  type Edge,
  type LathTree,
  leafTree,
  leaves,
  validate,
} from '../../lib/lath/model';
import type { Direction } from '../../lib/lath/layout';
import type { RestoreToken } from '../../lib/lath/ops';
import {
  type EnterFrom,
  type LathAnimator,
  LATH_EASING,
  LATH_MOTION_MS,
  createAnimator,
} from '../../lib/lath/animator';
import { prefersReducedMotion } from '../../lib/ui-geometry';
import { UNNAMED_PANEL_TITLE } from '../../lib/terminal-registry';
import type { ResolvedSplitDirection as DorResolvedSplitDirection } from 'dor/commands/types';
import type { DoorDirection } from '../../lib/spatial-nav';
import {
  type AddLeafPosition,
  type LathWallSnapshot,
  type LathWallStore,
  type LeafMeta,
  createLathWallStore,
} from './lath-wall-store';
import {
  type LathPersistedLayout,
  dockviewLayoutToLath,
  lathLayoutFromStore,
} from './lath-dockview-convert';
import type { DooredItem, VisiblePane } from './wall-types';

/** dor split direction → Lath edge. `'up'`/`'down'` map to the vertical axis. */
export function edgeForDorDirection(direction: DorResolvedSplitDirection): Edge {
  switch (direction) {
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'up':
      return 'top';
    case 'down':
      return 'bottom';
  }
}

/** Lath edge → dor resolved split direction (for `direction: 'auto'` resolution at
 *  the dor handler). `autoEdge` only ever returns `'right'`/`'bottom'`, but the full
 *  map is exhaustive. */
export function dorDirectionForEdge(edge: Edge): DorResolvedSplitDirection {
  switch (edge) {
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'top':
      return 'up';
    case 'bottom':
      return 'down';
  }
}

/** Lath edge → Door direction (Baseboard placement token; matches spatial-nav's
 *  `DoorDirection`). Mirrors the Edge→DoorDirection map in `remove`'s token edge. */
export function doorDirectionForEdge(edge: Edge): DoorDirection {
  switch (edge) {
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'top':
      return 'above';
    case 'bottom':
      return 'below';
  }
}

/** The edge a newly-placed leaf grows FROM — the boundary it shares with its
 *  reference, i.e. the edge opposite where it landed. A pane split to the `'right'`
 *  enters from its `'left'` edge; one placed `'bottom'` enters from its `'top'`. Feeds
 *  the animator's enter hint (the correct-for-all-four-directions successor to the
 *  coarse dockview `spawnDirectionForDockview`). */
export function enterFromForEdge(edge: Edge): EnterFrom {
  switch (edge) {
    case 'left':
      return 'right';
    case 'right':
      return 'left';
    case 'top':
      return 'bottom';
    case 'bottom':
      return 'top';
  }
}

/** Door direction → Lath edge (inverse of `doorDirectionForEdge`); used to
 *  synthesize a neighbor-tier token from a pre-Lath Door. */
export function edgeForDoorDirection(direction: DoorDirection): Edge {
  switch (direction) {
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'above':
      return 'top';
    case 'below':
      return 'bottom';
  }
}

/** Keyboard arrow → Lath spatial direction. */
export function directionForArrow(key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'): Direction {
  switch (key) {
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
  }
}

/** Default meta for a freshly-spawned terminal leaf (the Pane-props contract's
 *  read side; live titles still come from the terminal-state stores). */
export function terminalLeafMeta(title: string = UNNAMED_PANEL_TITLE): LeafMeta {
  return { component: 'terminal', tabComponent: 'terminal', title };
}

/** Meta for a browser (iframe / agent-browser) leaf. */
export function browserLeafMeta(title: string, params: Record<string, unknown>): LeafMeta {
  return { component: 'browser', tabComponent: 'surface', title, params };
}

/** Synthesize a neighbor-tier restore token for a Door persisted before Lath (or a
 *  dockview-created door that never captured a core token): no fingerprint (skips
 *  the exact tier), the sibling + edge reproduce the original split beside the
 *  neighbor, weight 0.5, index 0. Matches the spec's migration note that pre-Lath
 *  doors restore at the neighbor tier. */
export function legacyTokenFromDoor(item: DooredItem): RestoreToken {
  return {
    leafId: item.id,
    weight: 0.5,
    siblingId: item.neighborId,
    edge: edgeForDoorDirection(item.direction),
    index: 0,
    fingerprint: null,
  };
}

function isLathPersistedLayout(blob: unknown): blob is LathPersistedLayout {
  if (!blob || typeof blob !== 'object') return false;
  const b = blob as { version?: unknown; tree?: unknown; leafMeta?: unknown };
  if (b.version !== 1) return false;
  if (!b.tree || typeof b.tree !== 'object' || !('root' in (b.tree as object))) return false;
  return !!b.leafMeta && typeof b.leafMeta === 'object';
}

export type LathWallEngine = {
  /** The underlying headless store — handed to LathHost + the persistence
   *  subscription. */
  store: LathWallStore;

  // --- animation (stage 3; docs/specs/tiling-engine.md → "Animation contract") ---
  /** The headless motion core the HTML adapter drives from its rAF loop. Created
   *  with a 0 duration under reduced motion, so the same code path snaps instantly. */
  animator: LathAnimator;
  /** The kill-fade duration (ms) the Wall waits before committing `remove`. Equals
   *  the animator duration (0 under reduced motion). */
  exitMs: number;
  /** Record the edge a soon-to-be-added leaf should enter from (drained by LathHost
   *  at the next `retarget`). A plain map — not store state — so it never notifies. */
  setEnterHint(id: string, enterFrom: EnterFrom): void;
  /** Drain and return every pending enter hint (LathHost consumes these when it
   *  ingests a committed layout). */
  consumeEnterHints(): Map<string, EnterFrom>;
  /** Begin a leaf's exit fade (phase 1 of a kill); `shrinkTowardBottomRight` also
   *  collapses it toward its bottom-right corner (the last-pane kill). Idempotent. */
  markDying(id: string, opts?: { shrinkTowardBottomRight?: boolean }): void;
  /** Whether `id` is mid-fade — the Wall's re-entrant-kill guard. */
  isDying(id: string): boolean;
  /** Presentation-frame signal for chrome (the selection ring). LathHost's tick
   *  calls `notifyFrames(settled)`; subscribers re-measure. Returns an unsubscribe. */
  subscribeFrames(cb: (settled: boolean) => void): () => void;
  notifyFrames(settled: boolean): void;
  /** Wake signal for the adapter's tick loop — fired when the animator becomes busy
   *  without a store commit (i.e. `markDying`). Returns an unsubscribe. */
  subscribeWake(cb: () => void): () => void;

  // --- reads ---
  /** Visible leaves in tree pre-order, each with its meta title + params. */
  listPanes(): VisiblePane[];
  /** Whether `id` is a live leaf. */
  has(id: string): boolean;
  /** The leaf's metadata, or undefined. */
  getMeta(id: string): LeafMeta | undefined;
  /** Nearest neighbor of `id` in `direction`, or null. */
  neighborOf(id: string, direction: Direction): string | null;
  /** Aspect-ratio split edge for `id` (`autoEdge`). */
  autoEdgeFor(id: string): Edge;

  // --- store mutators (passthrough; rejected ops commit nothing) ---
  addLeaf(id: string, meta: LeafMeta, position: AddLeafPosition): { ok: boolean };
  removeLeaf(id: string): { ok: boolean; token: RestoreToken | null };
  replaceLeaf(oldId: string, newId: string, meta: LeafMeta): { ok: boolean };
  restoreLeaf(
    meta: LeafMeta,
    token: RestoreToken,
    opts?: { fallbackRef?: string },
  ): { ok: boolean; tier: 'exact' | 'neighbor' | 'fallback' | null };
  swapLeaves(a: string, b: string): { ok: boolean };
  setTitle(id: string, title: string): void;
  updateParams(id: string, patch: Record<string, unknown>): void;
  setZoomed(id: string | null): void;

  // --- persistence ---
  serializeLayout(): LathPersistedLayout;

  /** Hydration: prefer a persisted Lath layout, else migrate the dockview blob,
   *  else build a fresh tree from `initialPaneIds` (or one generated id). Returns
   *  the resulting pane ids (pre-order) and whether the fresh path was taken (so
   *  the Wall knows to prime default-shell opts, mirroring `addTerminalPanel`). */
  seed(
    lathBlob: unknown,
    dockviewBlob: unknown,
    initialPaneIds: string[] | undefined,
    generatePaneId: () => string,
  ): { paneIds: string[]; fresh: boolean };
};

export function createLathWallEngine(
  store: LathWallStore = createLathWallStore(),
  opts?: { durationMs?: number },
): LathWallEngine {
  const snapshot = (): LathWallSnapshot => store.getSnapshot();

  // 0 under reduced motion, so entry/exit/tween all collapse to instant through the
  // very same code path. Tests inject a fixed duration (or 0) via `opts`.
  const durationMs = opts?.durationMs ?? (prefersReducedMotion() ? 0 : LATH_MOTION_MS);
  const animator = createAnimator({ durationMs, easing: LATH_EASING });

  // Presentation-only side state (never in the store snapshot): enter hints drained
  // per retarget, the set of ids mid-fade, and the frame/wake listener sets.
  const enterHints = new Map<string, EnterFrom>();
  const dyingIds = new Set<string>();
  const frameListeners = new Set<(settled: boolean) => void>();
  const wakeListeners = new Set<() => void>();
  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  return {
    store,

    animator,
    exitMs: durationMs,
    setEnterHint(id, enterFrom) {
      enterHints.set(id, enterFrom);
    },
    consumeEnterHints() {
      const drained = new Map(enterHints);
      enterHints.clear();
      return drained;
    },
    markDying(id, markOpts) {
      if (dyingIds.has(id)) return;
      dyingIds.add(id);
      animator.markDying(id, now(), markOpts);
      for (const l of wakeListeners) l();
    },
    isDying: (id) => dyingIds.has(id),
    subscribeFrames(cb) {
      frameListeners.add(cb);
      return () => frameListeners.delete(cb);
    },
    notifyFrames(settled) {
      for (const l of frameListeners) l(settled);
    },
    subscribeWake(cb) {
      wakeListeners.add(cb);
      return () => wakeListeners.delete(cb);
    },

    listPanes() {
      const meta = snapshot().leafMeta;
      return store.leafIds().map((id) => {
        const m = meta.get(id);
        return { id, title: m?.title, params: m?.params };
      });
    },
    has: (id) => store.has(id),
    getMeta: (id) => snapshot().leafMeta.get(id),
    neighborOf: (id, direction) => store.neighborOf(id, direction),
    autoEdgeFor: (id) => store.autoEdgeFor(id),

    addLeaf: (id, meta, position) => store.addLeaf(id, meta, position),
    removeLeaf: (id) => {
      dyingIds.delete(id);
      return store.removeLeaf(id);
    },
    replaceLeaf: (oldId, newId, meta) => store.replaceLeaf(oldId, newId, meta),
    restoreLeaf: (meta, token, opts) => store.restoreLeaf(meta, token, opts),
    swapLeaves: (a, b) => store.swapLeaves(a, b),
    setTitle: (id, title) => store.setTitle(id, title),
    updateParams: (id, patch) => store.updateParams(id, patch),
    setZoomed: (id) => store.setZoomed(id),

    serializeLayout: () => lathLayoutFromStore(snapshot()),

    seed(lathBlob, dockviewBlob, initialPaneIds, generatePaneId) {
      // 1. A persisted Lath layout (must validate; empty trees fall through so the
      //    Wall always seeds ≥1 pane).
      if (isLathPersistedLayout(lathBlob)) {
        const tree = lathBlob.tree as LathTree;
        if (validate(tree).length === 0 && leaves(tree).length > 0) {
          store.seed(tree, Object.entries(lathBlob.leafMeta));
          return { paneIds: store.leafIds(), fresh: false };
        }
      }

      // 2. Migrate a legacy dockview blob (the other half of the dual-write).
      const migrated = dockviewLayoutToLath(dockviewBlob);
      if (migrated && leaves(migrated.tree).length > 0) {
        store.seed(migrated.tree, Object.entries(migrated.leafMeta));
        return { paneIds: store.leafIds(), fresh: false };
      }

      // 3. Fresh tree from the restored session ids (or one generated id), splitting
      //    successive panes via the store's autoEdge (as `addTerminalPanel` does).
      const ids = initialPaneIds && initialPaneIds.length > 0 ? initialPaneIds : [generatePaneId()];
      store.seed(leafTree(ids[0]), [[ids[0], terminalLeafMeta()]]);
      for (let i = 1; i < ids.length; i++) {
        store.addLeaf(ids[i], terminalLeafMeta(), null);
      }
      return { paneIds: store.leafIds(), fresh: true };
    },
  };
}
