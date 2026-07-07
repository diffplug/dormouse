// LathHost — the HTML adapter for Lath (docs/specs/tiling-engine.md → "Adapters;
// the HTML adapter (LathHost)"). The only non-headless piece of the engine: it
// subscribes to the store, runs the pure `layout`/`sashes` per render, and paints
// one stable absolutely-positioned div per leaf.
//
// Contracts it upholds (deviating from any of these needs a flagged reason):
//   - One div per leaf, keyed by id, rendered in a STABLE DOM order (sorted by id,
//     NOT tree order). React must never reorder keyed siblings, because moving an
//     <iframe>'s ancestor in the DOM reloads it. Position is purely geometric
//     (inline left/top/width/height); nothing is ever re-parented.
//   - Layout is a pure function of the tree + container rect, recomputed each
//     render. During a sash drag a local preview tree (core `resize` on the
//     drag-start tree with the cumulative delta) takes precedence; the store
//     commits only on pointerup via `onCommitResize`.
//   - The binding never calls `.focus()` and emits no activation events. Gestures
//     surface as proposals (`onCommitResize`, `onLeafFocused`); the Wall owns
//     selection/focus policy.

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type CSSProperties,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { type LathTree, type Rect, leaves } from '../../lib/lath/model';
import { type LayoutOpts, layout, sashes } from '../../lib/lath/layout';
import { type DropTarget, resize } from '../../lib/lath/ops';
import { type DropCandidate, hitTest } from '../../lib/lath/hit-test';
import { useFocusRingColor } from '../../lib/themes/use-focus-ring-color';
import { TERMINAL_SELECTION_BORDER_RADIUS } from '../design';
import type { PaneProps } from './pane-props';
import type { LathWallSnapshot, LeafMeta } from './lath-wall-store';
import { nowMs, type LathWallEngine } from './lath-wall-engine';
import { TerminalPanel } from './TerminalPanel';
import { BrowserPanel } from './BrowserPanel';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { SurfacePaneHeader } from './SurfacePaneHeader';

/** The geometry LathHost renders with. `gap: 6` matches today's `dormouseTheme.gap`;
 *  `minLeaf` ≈ dockview's default panel minimums. Exported so callers report the
 *  same opts to the store (`setLayoutGeometry`) that the host lays out with. */
export const LATH_LAYOUT_OPTS: LayoutOpts = { gap: 6, minLeaf: { width: 100, height: 60 } };

/** Widened pointer target over each (thin) sash band, in px. */
const SASH_HIT = 8;
/** Pointer travel (px) before a header press becomes a pane drag; below it the
 *  header's own click behavior (select / enter passthrough / rename) is untouched. */
const DRAG_THRESHOLD = 5;
/** Opacity applied to the dragged leaf while its drop preview floats elsewhere. */
const DRAG_DIM = '0.6';
/** Leaf stacking bands (mapped from the animator's discrete `Frame.layer`). Tiled
 *  survivors sit at 0; a dying leaf fades above them (and above the z-30 sashes);
 *  the zoomed leaf is highest. */
const Z_TILED = 0;
const Z_DYING = 35;
const Z_ZOOMED = 40;
/** The drop-preview overlay floats above every tiled/dying leaf (a drag can't start
 *  while a leaf is zoomed, so it never competes with `Z_ZOOMED`). */
const Z_PREVIEW = 45;

/** Lath never runs the CSS spawn-animation path (the animator owns entry): the leaf
 *  divs are registered for the animator via `registerEl`, but `getAnimEl` is a no-op
 *  so `usePaneChrome`'s class-based effect stays inert under Lath. */
const NOOP_GET_ANIM_EL = (): HTMLElement | null => null;

/** Test seam: swap the resolved body/tab components (keyed by component name) so
 *  jsdom tests never mount the real TerminalPane/xterm. */
export type LathComponentsOverride = {
  bodies?: Record<string, ComponentType<PaneProps>>;
  tabs?: Record<string, ComponentType<PaneProps>>;
};

// The same alias tables Wall.tsx uses: legacy `iframe` / `agent-browser` bodies
// resolve to the unified BrowserPanel; `surface` headers to SurfacePaneHeader.
const BODY_COMPONENTS: Record<string, ComponentType<PaneProps>> = {
  terminal: TerminalPanel,
  browser: BrowserPanel,
  iframe: BrowserPanel,
  'agent-browser': BrowserPanel,
};
const TAB_COMPONENTS: Record<string, ComponentType<PaneProps>> = {
  terminal: TerminalPaneHeader,
  surface: SurfacePaneHeader,
};

type DragState = {
  splitPath: number[];
  boundary: number;
  /** `'row'` split → the boundary is a vertical divider (col-resize). */
  dir: 'row' | 'col';
  startX: number;
  startY: number;
  /** The tree at drag start; every preview frame re-runs `resize` from it. */
  tree: LathTree;
  delta: number;
};

/** A live pane / Door drag session. Each frame hit-tests against the *live* store
 *  tree (read fresh, so a background `dor split`/`dor kill` commit mid-drag is
 *  reflected); `depth` indexes the hit-test candidates, cycled by the wheel and reset
 *  when the candidate list changes. */
type PaneDragState = {
  /** The dragged leaf (internal) or the Door being dragged in (external). */
  id: string;
  external: boolean;
  /** Crossed the drag threshold. Both internal and external drags start INACTIVE and
   *  apply the same threshold before activating. */
  active: boolean;
  startX: number;
  startY: number;
  candidates: DropCandidate[];
  depth: number;
  /** Serialized candidate targets — a change resets `depth` to the innermost. */
  candKey: string;
  lastX: number;
  lastY: number;
  rafId: number | null;
};

/** Stable per-id callbacks handed to each `LathLeaf`, cached so the memoized leaf
 *  never re-renders just because a parent commit minted a fresh closure. */
type LeafCallbacks = {
  registerEl: (el: HTMLDivElement | null) => void;
  onHeaderPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
};

/** One leaf div: header band atop a filling body, positioned purely by the inline
 *  geometry props. Memoized so a store commit or a drag frame only re-renders the
 *  leaves whose props actually changed (geometry / meta / resolved component).
 *  Static presentation (position/flex/overflow) lives in the `.lath-leaf*` CSS. */
const LathLeaf = memo(function LathLeaf({
  id,
  meta,
  Body,
  Tab,
  left,
  top,
  width,
  height,
  zIndex,
  hidden,
  registerEl,
  onHeaderPointerDown,
  onLeafFocused,
}: {
  id: string;
  meta: LeafMeta | undefined;
  Body: ComponentType<PaneProps> | undefined;
  Tab: ComponentType<PaneProps> | undefined;
  left: number;
  top: number;
  width: number;
  height: number;
  zIndex: number;
  /** A leaf with no frame (not laid out and not zoomed) hides rather than tiling. */
  hidden: boolean;
  registerEl: (el: HTMLDivElement | null) => void;
  /** Header-press → maybe a pane drag (threshold-gated inside LathHost). Stable. */
  onHeaderPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onLeafFocused?: (id: string) => void;
}) {
  // React writes the *target* geometry; while an animation is in flight LathHost
  // imperatively overrides left/top/width/height/opacity on the registered div, so a
  // meta re-render here can't snap a mid-tween leaf back to its resting rect. Inline
  // styles carry ONLY dynamic values; the rest is `.lath-leaf` CSS.
  const style: CSSProperties = hidden ? { display: 'none' } : { left, top, width, height, zIndex };
  const paneProps: PaneProps = {
    id,
    title: meta?.title,
    params: meta?.params,
    // Under Lath a mounted leaf is always engine-visible (no active-tab gating).
    panelVisible: true,
    // The animator owns entry; the CSS spawn path is disabled (no-op getAnimEl).
    getAnimEl: NOOP_GET_ANIM_EL,
  };
  return (
    <div
      data-lath-leaf={id}
      className="lath-leaf"
      style={style}
      ref={registerEl}
      onFocusCapture={() => onLeafFocused?.(id)}
    >
      <div className="lath-leaf-header" onPointerDown={onHeaderPointerDown}>
        {Tab ? <Tab {...paneProps} /> : null}
      </div>
      <div className="lath-leaf-body">{Body ? <Body {...paneProps} /> : null}</div>
    </div>
  );
});

/** Stable methods for the one pane/Door drag session. Built once per LathHost mount
 *  (a `useRef` factory), so the window handlers keep the same identity for the whole
 *  gesture and nothing re-subscribes on a Wall re-render. */
type DragController = {
  /** Begin an internal pane drag from a header press. Starts INACTIVE — the threshold
   *  gate runs in `onMove`, so a sub-threshold press keeps its click behavior. */
  beginInternal(id: string, clientX: number, clientY: number): void;
  /** Begin an external Door drag from its baseboard press. Also starts INACTIVE and
   *  applies the same threshold before activating. */
  beginExternal(id: string, startX: number, startY: number): void;
  /** The Wall cleared `externalDrag` (drop handled elsewhere / teardown) — stop any
   *  in-flight external drag cleanly. */
  endExternal(): void;
  /** Whether a pane/Door drag currently owns the pointer (the sash-drag guard). */
  hasDrag(): boolean;
  /** Unmount teardown: detach the window listeners and cancel any pending frame. */
  dispose(): void;
};

/** The mutable prop/snapshot surface the controller reads through, plus the stable
 *  React refs/setters it drives. All identities are stable across renders. */
type DragControllerDeps = {
  latestRef: MutableRefObject<{
    snapshot: LathWallSnapshot;
    onDragStart?: (id: string) => void;
    onProposeMove?: (id: string, target: DropTarget) => void;
    onProposeMinimize?: (id: string) => void;
    onExternalDrop?: (target: DropTarget | null) => void;
  }>;
  containerRef: RefObject<HTMLDivElement | null>;
  rectRef: MutableRefObject<Rect>;
  leafElsRef: MutableRefObject<Map<string, HTMLDivElement>>;
  /** Sash-drag session — the pane drag never starts while one is live. */
  sashDragRef: MutableRefObject<DragState | null>;
  setDragPreview: (rect: Rect | null) => void;
  suppressNextClickRef: MutableRefObject<boolean>;
};

function createDragController(deps: DragControllerDeps): DragController {
  // The live drag session (mutated in place by the window handlers).
  let drag: PaneDragState | null = null;
  // The last preview rect published to React state (`x,y,w,h`); a frame that lands in
  // the same band skips the redundant setState (and its forced re-layout).
  let lastPreviewKey = '';

  const publishPreview = (rect: Rect | null): void => {
    if (rect === null) {
      if (lastPreviewKey !== '') {
        lastPreviewKey = '';
        deps.setDragPreview(null);
      }
      return;
    }
    const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
    if (key === lastPreviewKey) return;
    lastPreviewKey = key;
    deps.setDragPreview(rect);
  };

  const detach = (): void => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('wheel', onWheel);
    if (drag && drag.rafId !== null) {
      cancelAnimationFrame(drag.rafId);
      drag.rafId = null;
    }
  };

  const attach = (): void => {
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    // Non-passive: the wheel cycles drop depth instead of scrolling.
    window.addEventListener('wheel', onWheel, { passive: false });
  };

  const runHitTest = (): void => {
    const d = drag;
    if (!d || !d.active) return;
    const containerEl = deps.containerRef.current;
    if (!containerEl) return;
    const cr = containerEl.getBoundingClientRect();
    // An internal drag below the wall is the baseboard minimize zone — no drop
    // candidates (the minimize is decided at `finish` from the pointer position). A Door
    // dropped there just cancels (dragged back down it stays a Door), so external skips it.
    if (!d.external && d.lastY > cr.bottom) {
      d.candidates = [];
      publishPreview(null);
      return;
    }
    const point = { x: d.lastX - cr.left, y: d.lastY - cr.top };
    // Hit-test the LIVE store tree so a background `dor split`/`dor kill` commit
    // mid-drag is reflected in the very next frame (the `candKey` reset below absorbs
    // the candidate list changing under the pointer).
    const cands = hitTest(deps.latestRef.current.snapshot.tree, deps.rectRef.current, point, d.external ? null : d.id, LATH_LAYOUT_OPTS);
    const key = cands.map((c) => JSON.stringify(c.target)).join('|');
    if (key !== d.candKey) {
      d.candKey = key;
      d.depth = 0; // a new candidate list starts at the innermost
    }
    d.candidates = cands;
    if (cands.length === 0) {
      publishPreview(null);
      return;
    }
    d.depth = Math.min(d.depth, cands.length - 1);
    publishPreview(cands[d.depth].previewRect);
  };

  const scheduleHitTest = (): void => {
    const d = drag;
    if (!d || d.rafId !== null) return;
    d.rafId = requestAnimationFrame(() => {
      if (!drag) return;
      drag.rafId = null;
      runHitTest();
    });
  };

  const finish = (commit: boolean): void => {
    const d = drag;
    detach();
    drag = null;
    publishPreview(null);
    if (d && !d.external) {
      const el = deps.leafElsRef.current.get(d.id);
      if (el) el.style.opacity = ''; // un-dim (the move commit tweens it into place)
    }
    if (!d) return;
    if (!d.active) {
      // Sub-threshold press: the click behavior stands (a Door click-reattaches; a
      // header selects). An external press that never became a drag still tells the Wall
      // to drop its transient door-drag state; no click suppression, so the Door's own
      // click still fires.
      if (d.external) deps.latestRef.current.onExternalDrop?.(null);
      return;
    }
    // A real drag happened → swallow the click the browser fires on pointerup so a drop
    // over a header/button/door does not also fire its click.
    deps.suppressNextClickRef.current = true;
    setTimeout(() => {
      deps.suppressNextClickRef.current = false;
    }, 0);
    const chosen = d.candidates.length > 0 ? d.candidates[Math.min(d.depth, d.candidates.length - 1)] : null;
    if (!commit) {
      if (d.external) deps.latestRef.current.onExternalDrop?.(null); // Escape → put the Door back
      return;
    }
    if (d.external) {
      deps.latestRef.current.onExternalDrop?.(chosen ? chosen.target : null);
      return;
    }
    // Internal: a release below the wall minimizes (derived here from the last pointer
    // position); otherwise commit the chosen move.
    const cr = deps.containerRef.current?.getBoundingClientRect();
    if (cr && d.lastY > cr.bottom) {
      deps.latestRef.current.onProposeMinimize?.(d.id);
      return;
    }
    if (chosen) deps.latestRef.current.onProposeMove?.(d.id, chosen.target);
  };

  function onMove(e: PointerEvent): void {
    const d = drag;
    if (!d) return;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    if (!d.active) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
      d.active = true;
      if (!d.external) {
        deps.latestRef.current.onDragStart?.(d.id); // Wall applies its selection policy
        const el = deps.leafElsRef.current.get(d.id);
        if (el) el.style.opacity = DRAG_DIM;
      }
    }
    scheduleHitTest();
  }

  function onUp(): void {
    finish(true);
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') finish(false);
  }

  function onWheel(e: WheelEvent): void {
    const d = drag;
    if (!d || !d.active || d.candidates.length === 0) return;
    e.preventDefault();
    const n = d.candidates.length;
    const step = e.deltaY > 0 ? 1 : -1; // scroll away/down → one level outward, wrap
    d.depth = ((d.depth + step) % n + n) % n;
    publishPreview(d.candidates[d.depth].previewRect);
  }

  return {
    beginInternal(id, clientX, clientY) {
      // One drag at a time; never during a sash drag or while a leaf is zoomed.
      if (drag || deps.sashDragRef.current) return;
      if (deps.latestRef.current.snapshot.zoomedId !== null) return;
      drag = {
        id, external: false, active: false, startX: clientX, startY: clientY,
        candidates: [], depth: 0, candKey: '', lastX: clientX, lastY: clientY, rafId: null,
      };
      attach();
    },
    beginExternal(id, startX, startY) {
      if (drag) return;
      drag = {
        id, external: true, active: false, startX, startY,
        candidates: [], depth: 0, candKey: '', lastX: startX, lastY: startY, rafId: null,
      };
      attach();
    },
    endExternal() {
      if (drag?.external) {
        detach();
        drag = null;
        publishPreview(null);
      }
    },
    hasDrag() {
      return drag !== null;
    },
    dispose() {
      detach();
    },
  };
}

export function LathHost({
  lath,
  onCommitResize,
  onLeafFocused,
  onDragStart,
  onProposeMove,
  onProposeMinimize,
  externalDrag,
  onExternalDrop,
  componentsOverride,
}: {
  /** The Wall's engine handle: LathHost reads `lath.store`, drives `lath.animator`,
   *  drains `lath.consumeEnterHints`, and pumps `lath.notifyFrames`. */
  lath: LathWallEngine;
  /** Wall commits the resize (as an op proposal) once the drag ends. */
  onCommitResize: (splitPath: number[], boundary: number, deltaPx: number) => void;
  /** focusin inside a leaf's subtree (embed self-focus adoption, acceptance row 8). */
  onLeafFocused?: (id: string) => void;
  /** A pane drag crossed its threshold — the Wall applies its selection policy. */
  onDragStart?: (id: string) => void;
  /** Drop of an internal pane drag onto a hit-tested target (the Wall commits `move`). */
  onProposeMove?: (id: string, target: DropTarget) => void;
  /** Drop of an internal pane drag onto the baseboard zone (the Wall minimizes it). */
  onProposeMinimize?: (id: string) => void;
  /** When set, a Door press began in the baseboard: LathHost starts an INACTIVE
   *  external drag from `{startX, startY}`, applies its own threshold, and once active
   *  hit-tests with `dragged: null` (no ghost — the chip stays in the baseboard) and
   *  reports the drop. A sub-threshold release reports `null` so the Wall clears the
   *  transient state and the Door's own click-reattach stands. */
  externalDrag?: { id: string; startX: number; startY: number } | null;
  /** Drop of an external (Door) drag: a hit-tested target, or `null` on cancel / a
   *  release over no candidate — the Wall leaves the Door where it is. */
  onExternalDrop?: (target: DropTarget | null) => void;
  componentsOverride?: LathComponentsOverride;
}) {
  const store = lath.store;
  const animator = lath.animator;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  // Measure the container and track resizes. `getBoundingClientRect` (not
  // `entry.contentRect`) so the measurement is trivially stubbable in jsdom.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((prev) => (prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rect = { x: 0, y: 0, width: size.width, height: size.height };
  const rectRef = useRef(rect);
  rectRef.current = rect;

  // The drop-preview overlay is painted in the selection ring's color (translucent
  // fill + solid border), so it reads as "this pane, dropped here".
  const selectionColor = useFocusRingColor();

  // Report the geometry we render with so the store's queries (restore/resize/
  // neighbors/autoEdge) match the screen.
  useEffect(() => {
    store.setLayoutGeometry({ x: 0, y: 0, width: size.width, height: size.height }, LATH_LAYOUT_OPTS);
  }, [store, size.width, size.height]);

  // --- Pane / Door drag (docs/specs/tiling-engine.md → "Hierarchical drag and
  // drop"). All pointer-event based (no HTML5 DnD), so it is CDP-testable and never
  // races React's synthetic events. One `DragController` (built once, below) owns the
  // window listeners and is entered two ways: an internal pane drag (a threshold-gated
  // header press) or an external Door drag (the Wall sets `externalDrag`, carrying the
  // press point). Both feed the same core `hitTest` and render one preview overlay. ---

  // Everything the once-built controller reads through: the latest store snapshot + Wall
  // callbacks, re-mirrored each render so it always sees current values.
  const latestRef = useRef({ snapshot, onDragStart, onProposeMove, onProposeMinimize, onExternalDrop });
  latestRef.current = { snapshot, onDragStart, onProposeMove, onProposeMinimize, onExternalDrop };

  // The current preview overlay rect (null → no overlay). The dragged leaf itself is
  // dimmed imperatively; only this rect is React state.
  const [dragPreview, setDragPreview] = useState<Rect | null>(null);
  // Set when a real drag ends so the click the browser synthesizes on pointerup does
  // not re-fire header/door click behavior; cleared by the click suppressor (or a tick).
  const suppressNextClickRef = useRef(false);
  // Stable map of each leaf's live div, written by `registerEl` and driven imperatively
  // by the animator frames + the drag-dim.
  const leafElsRef = useRef(new Map<string, HTMLDivElement>());

  // Sash drag: a local preview tree takes over layout until pointerup.
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<LathTree | null>(null);
  // Set on the store commit that ends a drag so the animator snaps rather than
  // tweens — the user placed the boundary by hand, and the animator's "from" would
  // otherwise be the pre-drag rects (the preview never touched it). Cleared by the
  // retarget effect that consumes it.
  const snapNextRef = useRef(false);

  // The single pane/Door drag controller, built once (window handlers stay stable for
  // the whole gesture; nothing re-subscribes on a Wall re-render).
  const dragControllerRef = useRef<DragController | null>(null);
  if (dragControllerRef.current === null) {
    dragControllerRef.current = createDragController({
      latestRef,
      containerRef,
      rectRef,
      leafElsRef,
      sashDragRef: dragRef,
      setDragPreview,
      suppressNextClickRef,
    });
  }
  const dragController = dragControllerRef.current;
  // Unmount teardown (the only lifecycle effect the controller needs — it is otherwise
  // driven imperatively).
  useEffect(() => () => dragController.dispose(), [dragController]);

  useEffect(() => {
    if (!dragging) return;
    // Coalesce pointermove: stash the latest cumulative delta and recompute the
    // preview at most once per animation frame (the resize itself is cheap, but a
    // React commit per pointer event is not).
    let rafId: number | null = null;
    const flush = () => {
      rafId = null;
      const d = dragRef.current;
      if (!d) return;
      setPreview(resize(d.tree, d.splitPath, d.boundary, d.delta, rectRef.current, LATH_LAYOUT_OPTS).tree);
    };
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      d.delta = d.dir === 'row' ? e.clientX - d.startX : e.clientY - d.startY;
      if (rafId === null) rafId = requestAnimationFrame(flush);
    };
    const end = (commit: boolean) => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      const d = dragRef.current;
      dragRef.current = null;
      setDragging(false);
      setPreview(null);
      if (commit && d) {
        snapNextRef.current = true; // the resulting resize commit snaps, doesn't tween
        onCommitResize(d.splitPath, d.boundary, d.delta);
      }
    };
    const onUp = () => end(true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') end(false); // cancel: revert the preview, commit nothing
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [dragging, onCommitResize]);

  const activeTree = preview ?? snapshot.tree;
  const frames = layout(activeTree, rect, LATH_LAYOUT_OPTS);
  const sashList = sashes(activeTree, rect, LATH_LAYOUT_OPTS);

  // DOM order is sorted-by-id and STABLE across layout changes; z-index (not DOM
  // order) lifts the zoomed leaf, so keyed siblings never reorder. `leaves()`
  // already returns a fresh array, so sort it in place.
  const sortedIds = leaves(snapshot.tree).sort();
  const zoomedId = snapshot.zoomedId;

  // Create-once-per-id callback bundle so the memoized LathLeaf sees a stable
  // `registerEl` identity across commits.
  const leafCallbacksRef = useRef(new Map<string, LeafCallbacks>());
  const leafCallbacks = (id: string): LeafCallbacks => {
    let cb = leafCallbacksRef.current.get(id);
    if (!cb) {
      cb = {
        registerEl: (el) => {
          if (el) {
            leafElsRef.current.set(id, el);
          } else {
            // Leaf unmounted (removed from the tree) — drop both its div and its cached
            // callbacks so the maps don't accumulate dead ids.
            leafElsRef.current.delete(id);
            leafCallbacksRef.current.delete(id);
          }
        },
        onHeaderPointerDown: (e) => {
          // Primary button only; leave header buttons / the rename input alone so a
          // press on them keeps its click behavior (they never start a drag). The
          // header's own onMouseDown (select / passthrough) still runs — a plain
          // click below the threshold is untouched.
          if (e.button !== 0) return;
          const t = e.target as HTMLElement;
          if (t.closest('button, input, textarea, [contenteditable]')) return;
          dragController.beginInternal(id, e.clientX, e.clientY);
        },
      };
      leafCallbacksRef.current.set(id, cb);
    }
    return cb;
  };

  // Mirror the Wall's `externalDrag` (a Door press in the baseboard) into the
  // controller. Keyed on the id so the Wall passing a fresh object each render never
  // re-fires; the press coords are read from the render where the id became non-null.
  const externalDragId = externalDrag?.id ?? null;
  useEffect(() => {
    if (externalDrag) dragController.beginExternal(externalDrag.id, externalDrag.startX, externalDrag.startY);
    else dragController.endExternal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalDragId]);

  // Swallow the one click the browser synthesizes after a real drag (so a drop over a
  // header/button/door does not also fire its click). Capture phase, so React's own
  // bubble-phase onClick never runs.
  useEffect(() => {
    const onClickCapture = (e: MouseEvent): void => {
      if (!suppressNextClickRef.current) return;
      suppressNextClickRef.current = false;
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener('click', onClickCapture, true);
    return () => window.removeEventListener('click', onClickCapture, true);
  }, []);

  // --- Animation: imperatively apply the animator's interpolated frames to the leaf
  // divs (docs/specs/tiling-engine.md → "Animation contract"). React renders the
  // TARGET geometry; these writes override it while a tween/fade is in flight. ---

  const rafRef = useRef<number | null>(null);
  // Holds the latest `step` for the rAF schedule inside `pump`, so `pump` needn't take
  // `step` as a dependency (they reference each other).
  const stepRef = useRef<() => void>(() => {});
  // The zoomed leaf is React-driven (full-rect) and never animated, so `applyFrames`
  // skips it. Kept in a ref so the rAF callback always sees the latest.
  const zoomedIdRef = useRef<string | null>(null);
  zoomedIdRef.current = zoomedId;

  const applyFrames = useCallback(
    (t: number) => {
      const paint = animator.framesAt(t);
      const zoomed = zoomedIdRef.current;
      for (const [id, el] of leafElsRef.current) {
        if (id === zoomed) continue; // zoom owns its full-rect geometry
        const f = paint.get(id);
        if (!f) continue; // not tracked (e.g. just-removed) — leave React's styles
        el.style.left = `${f.rect.x}px`;
        el.style.top = `${f.rect.y}px`;
        el.style.width = `${f.rect.width}px`;
        el.style.height = `${f.rect.height}px`;
        el.style.opacity = f.opacity >= 1 ? '' : `${f.opacity}`;
        if (f.layer >= 1) {
          // Dying: fade above the survivors and swallow no pointer events.
          el.style.zIndex = `${Z_DYING}`;
          el.style.pointerEvents = 'none';
        } else {
          el.style.zIndex = `${Z_TILED}`;
          el.style.pointerEvents = '';
        }
      }
    },
    [animator],
  );

  // The single tick body and the loop's entry point (from the retarget effects and the
  // markDying wake): paint now — this runs pre-paint when called from a layout effect,
  // so the first frame is correct — tell chrome, and schedule the loop while anything is
  // still moving. Reschedules only when no frame is already pending.
  const pump = useCallback(() => {
    const t = nowMs();
    applyFrames(t);
    const settled = animator.settledAt(t);
    lath.notifyFrames(settled);
    if (!settled && rafRef.current === null) rafRef.current = requestAnimationFrame(stepRef.current);
  }, [applyFrames, animator, lath]);

  // The scheduled rAF callback: clear the handle it just consumed, then re-enter `pump`
  // (whose reschedule guard now passes, continuing the loop while still unsettled).
  const step = useCallback(() => {
    rafRef.current = null;
    pump();
  }, [pump]);
  stepRef.current = step;

  // A committed layout change (store commit that alters the tree). Retarget every
  // leaf FROM its current interpolated frame (interruptible); a sash-drag commit
  // snaps instead. Keyed on tree identity so meta/zoom commits never retarget (the
  // other referenced values are stable refs/callbacks).
  useLayoutEffect(() => {
    const targets = layout(snapshot.tree, rectRef.current, LATH_LAYOUT_OPTS);
    animator.retarget(targets, nowMs(), lath.consumeEnterHints(), { snap: snapNextRef.current });
    snapNextRef.current = false;
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.tree]);

  // A container resize re-lays out instantly (snap) — tweening every resize frame
  // would lag. Skipped before the first measurement.
  useLayoutEffect(() => {
    if (size.width === 0 && size.height === 0) return;
    const targets = layout(snapshot.tree, { x: 0, y: 0, width: size.width, height: size.height }, LATH_LAYOUT_OPTS);
    animator.retarget(targets, nowMs(), undefined, { snap: true });
    pump();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height]);

  // After EVERY React commit, re-assert the animator frames while unsettled — a
  // mid-tween re-render (e.g. a meta/title change) would otherwise snap the div's
  // inline styles back to the resting target. Cheap: bails the instant we're settled.
  useLayoutEffect(() => {
    if (!animator.settledAt(nowMs())) pump();
  });

  // Wake the tick loop when the animator becomes busy WITHOUT a store commit —
  // `markDying` starts a fade but does not touch the tree, so no retarget effect fires.
  useEffect(() => lath.subscribeWake(pump), [lath, pump]);

  // Stop the loop on unmount.
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const resolveBody = (component: string): ComponentType<PaneProps> | undefined =>
    componentsOverride?.bodies?.[component] ?? BODY_COMPONENTS[component];
  const resolveTab = (tabComponent: string): ComponentType<PaneProps> | undefined =>
    componentsOverride?.tabs?.[tabComponent] ?? TAB_COMPONENTS[tabComponent];

  return (
    <div ref={containerRef} className="lath-host">
      {sortedIds.map((id) => {
        const meta = snapshot.leafMeta.get(id);
        const f = frames.get(id);
        const isZoomed = zoomedId === id;
        // Geometry passed as primitives so the memoized leaf can shallow-compare.
        // Zoomed → full rect on top; laid-out → its frame at z 0; neither → hidden.
        const cb = leafCallbacks(id);
        const geom = isZoomed
          ? { left: 0, top: 0, width: rect.width, height: rect.height, zIndex: Z_ZOOMED, hidden: false }
          : f
            ? { left: f.x, top: f.y, width: f.width, height: f.height, zIndex: Z_TILED, hidden: false }
            : { left: 0, top: 0, width: 0, height: 0, zIndex: Z_TILED, hidden: true };
        return (
          <LathLeaf
            key={id}
            id={id}
            meta={meta}
            Body={meta ? resolveBody(meta.component) : undefined}
            Tab={meta ? resolveTab(meta.tabComponent) : undefined}
            {...geom}
            registerEl={cb.registerEl}
            onHeaderPointerDown={cb.onHeaderPointerDown}
            onLeafFocused={onLeafFocused}
          />
        );
      })}

      {sashList.map((sash) => {
        const vertical = sash.dir === 'row'; // a 'row' split's boundary is a vertical divider
        // Inline carries ONLY geometry + cursor; position/z-index/touch-action are
        // the `.lath-sash` CSS (z-index 30 sits above tiled leaves at z 0 and below
        // the zoomed leaf at z 40, which hides them).
        const style: CSSProperties = vertical
          ? {
              left: sash.rect.x - (SASH_HIT - sash.rect.width) / 2,
              top: sash.rect.y,
              width: SASH_HIT,
              height: sash.rect.height,
              cursor: 'col-resize',
            }
          : {
              left: sash.rect.x,
              top: sash.rect.y - (SASH_HIT - sash.rect.height) / 2,
              width: sash.rect.width,
              height: SASH_HIT,
              cursor: 'row-resize',
            };
        return (
          <div
            key={`sash-${sash.splitPath.join('.')}-${sash.boundary}`}
            data-lath-sash={`${sash.splitPath.join('.')}-${sash.boundary}`}
            className="lath-sash"
            style={style}
            onPointerDown={(e) => {
              if (dragController.hasDrag()) return; // a pane drag has the pointer
              e.preventDefault();
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
              dragRef.current = {
                splitPath: sash.splitPath,
                boundary: sash.boundary,
                dir: sash.dir,
                startX: e.clientX,
                startY: e.clientY,
                tree: snapshot.tree,
                delta: 0,
              };
              setDragging(true);
              setPreview(snapshot.tree);
            }}
          />
        );
      })}

      {/* Drop-preview overlay: the exact rect the current candidate would commit to,
          painted in the selection color (translucent fill + solid border). */}
      {dragPreview && (
        <div
          data-lath-drop-preview=""
          className="lath-drop-preview"
          style={{
            left: dragPreview.x,
            top: dragPreview.y,
            width: dragPreview.width,
            height: dragPreview.height,
            zIndex: Z_PREVIEW,
            border: `1px solid ${selectionColor}`,
            borderRadius: TERMINAL_SELECTION_BORDER_RADIUS,
            backgroundColor: `color-mix(in srgb, ${selectionColor} 22%, transparent)`,
          }}
        />
      )}
    </div>
  );
}
