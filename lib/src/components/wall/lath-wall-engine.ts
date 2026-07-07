// The Wall-facing Lath engine handle (docs/specs/tiling-engine.md → "The wall store
// and engine"). The store (`lath-wall-store.ts`) is the state machine + geometry +
// enter hints; the engine layers presentation, vocabulary, and persistence
// conveniences over it — the animator (entry/exit/tween + dying state), the
// pane-list / meta projections, the dor-direction ↔ Edge ↔ Door-direction maps, the
// leaf-meta builders, the legacy-Door → neighbor-tier token bridge, and the
// three-way hydration `seed` + `serializeLayout`. Every state op and geometry query
// goes straight to `lath.store.*`; the engine no longer re-exports them.
//
// The engine holds NO selection/focus/mode/activation state — those stay in the Wall.

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
  type LathAnimator,
  LATH_EASING,
  LATH_MOTION_MS,
  createAnimator,
} from '../../lib/lath/animator';
import { prefersReducedMotion } from '../../lib/ui-geometry';
import { UNNAMED_PANEL_TITLE } from '../../lib/terminal-registry';
import type { ResolvedSplitDirection as DorResolvedSplitDirection } from 'dor/commands/types';
import type { DoorDirection } from '../../lib/session-types';
import {
  type LathWallSnapshot,
  type LathWallStore,
  type LeafMeta,
  createLathWallStore,
} from './lath-wall-store';
import { dockviewLayoutToLath } from './lath-dockview-convert';
import {
  type LathPersistedLayout,
  isLathPersistedLayout,
  lathLayoutFromStore,
} from './lath-persistence';
import type { DooredItem, VisiblePane } from './wall-types';

/** Wall-clock reader for the animator (the single definition — LathHost imports it
 *  rather than duplicating one). Kept out of the pure core, which always takes `now`
 *  as an argument; isolated here so tests can mock `performance.now`. */
export const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

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

/** Door direction → Lath edge (Baseboard placement token, matching session-types'
 *  `DoorDirection`); used to synthesize a neighbor-tier token from a pre-Lath Door. */
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

/** The engine-tracked meta for a Door's surface. Shared by the two reattach paths —
 *  click-reattach (`restore`) and drag-out (`insert`) — so they build the same shape.
 *  Legacy `'iframe'` / `'agent-browser'` component aliases are canonicalized to
 *  `'browser'` here, so a leaf always carries the canonical body key: a re-minimize
 *  reads `meta.component` straight through, and `reconnect.ts`'s `component ===
 *  'browser'` filter keys off it. Component/tabComponent default to terminal for
 *  pre-Lath doors that carry neither. */
export function leafMetaFromDoor(item: DooredItem): LeafMeta {
  const component = item.component === 'iframe' || item.component === 'agent-browser'
    ? 'browser'
    : item.component ?? 'terminal';
  return {
    component,
    tabComponent: item.tabComponent ?? 'terminal',
    title: item.title,
    params: item.params,
  };
}

/** Synthesize a neighbor-tier restore token for a Door persisted before Lath (no
 *  core `token`): no fingerprint (skips the exact tier), the sibling + edge reproduce
 *  the original split beside the neighbor, weight 0.5, index 0. Missing legacy fields
 *  degrade gracefully — an absent `neighborId` (null sibling) falls to the fallback
 *  tier at restore, and an absent `direction` defaults to `'right'`. */
export function legacyTokenFromDoor(item: DooredItem): RestoreToken {
  return {
    leafId: item.id,
    weight: 0.5,
    siblingId: item.neighborId ?? null,
    edge: edgeForDoorDirection(item.direction ?? 'right'),
    index: 0,
    fingerprint: null,
  };
}

export type LathWallEngine = {
  /** The underlying headless store — the state machine + geometry every state op and
   *  query goes through directly (`lath.store.*`), and the reader LathHost + the
   *  persistence subscription subscribe to. */
  store: LathWallStore;

  // --- animation (stage 3; docs/specs/tiling-engine.md → "Animation contract") ---
  /** The headless motion core the HTML adapter drives from its rAF loop. Created
   *  with a 0 duration under reduced motion, so the same code path snaps instantly. */
  animator: LathAnimator;
  /** The kill-fade duration (ms) the Wall waits before committing `remove`. Equals
   *  the animator duration (0 under reduced motion). */
  exitMs: number;
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

  // --- reads / projections over the store ---
  /** Visible leaves in tree pre-order, each with its meta title + params. */
  listPanes(): VisiblePane[];
  /** The leaf's metadata, or undefined. */
  getMeta(id: string): LeafMeta | undefined;

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

  // Presentation-only side state (never in the store snapshot): the frame/wake
  // listener sets. Enter hints live in the store; dying state lives in the animator.
  const frameListeners = new Set<(settled: boolean) => void>();
  const wakeListeners = new Set<() => void>();

  return {
    store,

    animator,
    exitMs: durationMs,
    markDying(id, markOpts) {
      // The animator owns dying state (idempotent per id); wake the tick loop, since
      // a fade starts no store commit and so fires no retarget effect.
      animator.markDying(id, nowMs(), markOpts);
      for (const l of wakeListeners) l();
    },
    isDying: (id) => animator.isDying(id),
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
    getMeta: (id) => snapshot().leafMeta.get(id),

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

      // 2. Migrate a legacy dockview blob (one-way upgrade for pre-Lath saves).
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
