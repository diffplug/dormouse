import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { getWorkspaceUiSnapshot, subscribeToWorkspaceUi } from '../../lib/workspace-ui-store';
import { subscribeWorkspaceMotionFrames } from '../workspace-motion';
import {
  FOCUS_MOTION_MS,
  PANE_GUTTER_PX,
  PANE_SELECTION_RING_RADIUS_PX,
  SELECTION_RING_INFLATE_PX,
  TERMINAL_BORDER_RADIUS_PX,
} from '../design';
import { cfg } from '../../cfg';
import { motionIsInstant } from '../../lib/ui-geometry';
import {
  retargetRingTween,
  sampleRingTween,
  sampleRingVelocity,
  startRingTween,
  type RingEdgeSpeeds,
  type RingFrame,
  type RingRect,
  type RingShape,
  type RingTween,
} from '../../lib/rect-tween';
import { useFocusRingColor } from '../../lib/themes/use-focus-ring-color';
import { resolvePaneElement } from './resolve-pane-element';
import { isWorkspaceSelection, workspaceIdOfSelection, type WallMode, type WallSelectionKind } from './wall-types';
import { DoorElementsContext, PaneElementsContext, RingHandoffContext, WindowFocusedContext } from './wall-context';
import { workspaceTabElement } from '../workspace-tab-elements';
import { getWorkspacesSnapshot, subscribeToWorkspaces } from '../../lib/workspace-store';
import {
  CORNER_EDGES,
  cornerPath,
  edgePath,
  isRingCorner,
  RING_PIECES,
  ringPerimeter,
  roundedRectPath,
  type RingEdge,
} from '../../lib/ring-geometry';
import { SelectionRing } from './SelectionRing';
import { rectUnionOutline, roundedUnionOutline, unionBounds } from '../../lib/rect-union-outline';

/** The subset of the Lath store the overlay needs — a revision that bumps on every
 *  commit, so the ring re-measures as leaves move / resize / restore. Kept
 *  structural so this module doesn't hard-depend on the store. */
export interface LathOverlayStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { revision: number };
}

/** Concentric-corners rule (design.tsx): the pane ring draws on a rect inflated by
 *  SELECTION_RING_INFLATE_PX, so its edge radius is the pane radius plus that
 *  offset; the door ring draws on the door rect itself and keeps the pane radius,
 *  rounding only the top corners. The `inset` shrinks the marching-ants path so its
 *  stroke centerline stays on the gutter's midline: the pane inset lands the
 *  centerline at PANE_GUTTER_PX / 2 from the pane edge (the same line the 1px
 *  passthrough border sits on); the door ring has no gutter, so it straddles the
 *  door edge (inset = strokeWidth / 2). Workspace tabs share that shape; the +
 *  button keeps its 4px all-round corners. Radii + inset ride the tween. */
function ringShape(kind: WallSelectionKind): RingShape {
  if (kind === 'workspace-new') {
    return { tl: 4, tr: 4, br: 4, bl: 4, inset: cfg.marchingAnts.strokeWidth / 2 };
  }
  if (kind !== 'pane') {
    const r = TERMINAL_BORDER_RADIUS_PX;
    return { tl: r, tr: r, br: 0, bl: 0, inset: cfg.marchingAnts.strokeWidth / 2 };
  }
  const r = PANE_SELECTION_RING_RADIUS_PX;
  return { tl: r, tr: r, br: r, bl: r, inset: SELECTION_RING_INFLATE_PX - PANE_GUTTER_PX / 2 };
}

function measureFrame(el: HTMLElement, kind: WallSelectionKind): RingFrame | null {
  if (!el.isConnected) return null;
  const r = el.getBoundingClientRect();
  // A removed Door may still be in the element map until its effect cleans up;
  // a restored leaf can likewise be mounted before it has a nonempty frame.
  // Neither is a visible destination. Keep the last painted ring as the origin.
  if (r.width <= 0 || r.height <= 0) return null;
  const inflate = kind === 'pane' ? SELECTION_RING_INFLATE_PX : 0;
  return {
    rect: {
      top: r.top - inflate,
      left: r.left - inflate,
      width: r.width + inflate * 2,
      height: r.height + inflate * 2,
    },
    shape: ringShape(kind),
  };
}

// The active selection's identity; the travel tween restarts when it changes.
function ringIdentity(type: WallSelectionKind, id: string): string {
  return `${type}:${id}`;
}

const rectsEqual = (a: RingRect, b: RingRect) =>
  a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;

const insetRect = (r: RingRect, d: number): RingRect =>
  ({ left: r.left + d, top: r.top + d, width: r.width - 2 * d, height: r.height - 2 * d });

function framesEqual(a: RingFrame, b: RingFrame): boolean {
  return (
    rectsEqual(a.rect, b.rect)
    && (a.union === b.union || !!a.union && !!b.union && a.union.every((r, i) => rectsEqual(r, b.union![i])))
    && a.shape.tl === b.shape.tl && a.shape.tr === b.shape.tr
    && a.shape.br === b.shape.br && a.shape.bl === b.shape.bl
    && a.shape.inset === b.shape.inset
  );
}

/** The frame the ring currently shows: geometry plus the per-edge motion-smear
 *  `speeds`, populated only while a tween runs; a settled ring carries null speeds,
 *  so its render is clean. `union` holds the source and helper rects while a terminal
 *  context is open; `rect` is then their bounds, and both rectangles tween together.
 *  Held in a ref and written to the DOM imperatively. */
interface DisplayedRing {
  rect: RingRect;
  shape: RingShape;
  speeds: RingEdgeSpeeds | null;
  union?: readonly [RingRect, RingRect];
}

/**
 * Draw the eight-piece motion smear underneath the ring, or hide it when the ring
 * is settled. `shape.inset` is the effective inset for the active variant, so this
 * is the only inset in play.
 *
 * Each edge smears only by its OWN motion across itself, so the four are
 * independent — see `docs/specs/layout.md` → "Ring travel" for why a single
 * ring-centre velocity gets ordinary split layouts wrong.
 *
 * Straight edges carry their width in a plain `stroke-width`. Corners cannot —
 * they have to reach two different widths at once — so each is stroked at unit
 * width and scaled, which tapers it between its neighbours (`cornerPath`).
 */
function writeSmear(
  group: SVGGElement,
  rect: RingRect,
  shape: RingShape,
  strokeWidth: number,
  speeds: RingEdgeSpeeds | null,
): void {
  if (!speeds) {
    group.style.display = 'none';
    return;
  }
  group.style.display = '';

  const { smearFullSpeed, smearMaxPx, smearPeakAlpha } = cfg.focusRing;
  // One signal, two channels. `t` is this edge's speed normalized against the
  // speed at which the smear is fully developed; extent and intensity are then
  // independent linear ramps off it, each with its own ceiling. Both start at
  // zero, so an edge that is not moving contributes nothing rather than laying a
  // band under the crisp ring.
  //
  // Intensity deliberately does NOT divide by the widening factor. Strict ink
  // conservation ties peak alpha to the extent (a wider smear is proportionally
  // fainter, total ink fixed), which makes the effect impossible to strengthen by
  // widening it — the same ink just spreads thinner.
  const band = (speed: number) => {
    const t = Math.min(1, speed / smearFullSpeed);
    return {
      width: strokeWidth + t * (smearMaxPx - strokeWidth),
      opacity: t * smearPeakAlpha,
    };
  };
  const bands: Record<RingEdge, ReturnType<typeof band>> = {
    top: band(speeds.top),
    right: band(speeds.right),
    bottom: band(speeds.bottom),
    left: band(speeds.left),
  };

  for (const piece of RING_PIECES) {
    const el = group.querySelector<SVGPathElement>(`[data-piece="${piece}"]`);
    if (!el) continue;
    if (!isRingCorner(piece)) {
      const { width, opacity } = bands[piece];
      el.setAttribute('d', edgePath(piece, rect, shape));
      el.setAttribute('stroke-width', `${width}`);
      el.setAttribute('stroke-opacity', `${opacity}`);
      el.removeAttribute('transform');
      continue;
    }
    // Corner: `a` is the vertical neighbour's width, `b` the horizontal one, so
    // the unit stroke renders exactly each neighbour's width where it meets it.
    const [vertical, horizontal] = CORNER_EDGES[piece];
    const a = bands[vertical].width;
    const b = bands[horizontal].width;
    el.setAttribute('d', cornerPath(piece, rect, shape, a, b));
    el.setAttribute('stroke-width', '1');
    el.setAttribute('transform', `scale(${a} ${b})`);
    // Opacity cannot vary along a stroke, so a corner takes the mean of the two
    // edges it joins.
    el.setAttribute('stroke-opacity', `${(bands[vertical].opacity + bands[horizontal].opacity) / 2}`);
  }
}

export function WorkspaceSelectionOverlay({ lathStore, subscribeLathFrames, selectedId, selectedType, mode, active = true, contextSourceId }: {
  /** The Lath store — the overlay re-measures on every commit (`revision` via
   *  `useSyncExternalStore`), so the ring tracks leaves as they move / resize / restore. */
  lathStore: LathOverlayStore;
  /** The animator's per-frame subscribe (LathHost pumps it). While the wall streams
   *  frames the ring re-measures the moving leaf each frame; same-identity updates
   *  snap 1:1 so the ring tracks the streamed geometry exactly. Optional-null for tests. */
  subscribeLathFrames?: ((cb: (settled: boolean) => void) => () => void) | null;
  selectedId: string | null;
  selectedType: WallSelectionKind;
  mode: WallMode;
  active?: boolean;
  contextSourceId?: string;
}) {
  const { elements: paneElements, version: paneVersion } = useContext(PaneElementsContext);
  const { elements: doorElements, version: doorVersion } = useContext(DoorElementsContext);
  const selectionColor = useFocusRingColor();
  const windowFocused = useContext(WindowFocusedContext);
  const handoff = useContext(RingHandoffContext);
  const wasActiveRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const workspaces = useSyncExternalStore(subscribeToWorkspaces, getWorkspacesSnapshot);
  const { renamingId } = useSyncExternalStore(subscribeToWorkspaceUi, getWorkspaceUiSnapshot);

  // The ring shell mounts when there's a measured frame to show; per-frame geometry
  // is written imperatively (below), never via React state — so a travelling ring
  // does not reconcile this subtree each frame. `visibleRef` mirrors the state for
  // the effect's synchronous reads.
  const [visible, setVisible] = useState(false);
  const visibleRef = useRef(false);

  // DOM nodes owned by SelectionRing, lifted here so the rAF loop can mutate them
  // directly (the LathHost/animator split: React renders structure, the frame owns
  // the mutations).
  const containerRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const smearRef = useRef<SVGGElement>(null);

  // Latest values the imperative writer reads. `frameRef` is the frame on screen;
  // `modeRef` mirrors the current mode so any `applyRing` closure derives the right
  // variant without a stale capture.
  const frameRef = useRef<DisplayedRing | null>(null);
  const opacityRef = useRef('');
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Refs survive the measuring effect's re-runs (lathRevision / paneVersion /
  // doorVersion): the ring's current on-screen frame (the tween's `from` on an
  // identity change), the identity it belongs to, the live tween, and the pending
  // rAF handle. The tween is a pure function of time (rect-tween.ts); this loop is
  // its only DOM/React driver.
  const displayedFrameRef = useRef<RingFrame | null>(null);
  const displayedIdentityRef = useRef<string | null>(null);
  const tweenRef = useRef<RingTween | null>(null);
  const rafRef = useRef<number | null>(null);

  // Write the current frame to the DOM: container geometry, the ring path, the
  // marching-ants dash (command mode), and the directional smear. Reads
  // everything from refs so it is correct no matter which closure calls it (the rAF
  // tick, a snap, or the post-render re-apply below).
  const applyRing = useCallback(() => {
    const frame = frameRef.current;
    const container = containerRef.current;
    const path = pathRef.current;
    if (!frame || !container || !path) return;
    const { rect, shape, speeds, union } = frame;

    container.style.top = `${rect.top}px`;
    container.style.left = `${rect.left}px`;
    container.style.width = `${rect.width}px`;
    container.style.height = `${rect.height}px`;
    container.style.opacity = opacityRef.current;

    const isAnts = modeRef.current !== 'passthrough';
    const strokeWidth = isAnts ? cfg.marchingAnts.strokeWidth : 1;
    // Solid centers its 1px stroke a fixed strokeWidth/2 (0.5) inside the div edge —
    // pixel-parity with the retired CSS border; ants uses the shape's lerped inset.
    // Resolved once here so every path builder below sees a single inset.
    const effShape = isAnts ? shape : { ...shape, inset: strokeWidth / 2 };

    const outline = union && roundedUnionOutline(
      rectUnionOutline(insetRect(union[0], effShape.inset), insetRect(union[1], effShape.inset)).map(p => ({ x: p.x - rect.left, y: p.y - rect.top })),
      Math.max(0, effShape.tl - effShape.inset));
    path.setAttribute('d', outline ? outline.path : roundedRectPath(rect, effShape));
    path.dataset.contextUnion = outline ? 'true' : 'false';

    if (isAnts) {
      // Dash sized to the perimeter so the segments stay even as the ring resizes.
      // Computed in closed form rather than via `path.getTotalLength()`, which
      // forces a synchronous style+layout flush on every frame of a travel at a
      // cost that scales with the whole document, not this one path.
      const len = outline ? outline.perimeter : ringPerimeter(rect, effShape);
      const count = Math.max(1, Math.round(len / cfg.marchingAnts.segLen));
      const adjusted = len / count;
      const dash = adjusted * cfg.marchingAnts.dashFraction;
      const gap = adjusted - dash;
      path.setAttribute('stroke-dasharray', `${dash} ${gap}`);
      path.style.setProperty('--march-offset', `-${adjusted}px`);
    } else {
      // The path element is shared across variants and the dash is an imperative
      // write React never reconciles away — clear it, or a command→passthrough
      // flip leaves the 1px solid ring rendering the ants' dash (a dotted line).
      path.removeAttribute('stroke-dasharray');
      path.style.removeProperty('--march-offset');
    }

    const smear = smearRef.current;
    if (smear) writeSmear(smear, rect, effShape, strokeWidth, speeds);
  }, []);

  // Re-run the measuring effect after each Lath commit. Runs post-render, so
  // `getBoundingClientRect` sees the repositioned leaf divs.
  const lathRevision = useSyncExternalStore(lathStore.subscribe, () => lathStore.getSnapshot().revision);

  useEffect(() => {
    // Show a frame: record it, then either apply it now (already mounted) or mount
    // the shell (the post-render layout effect applies it before paint).
    const show = (frame: DisplayedRing) => {
      frameRef.current = frame;
      displayedFrameRef.current = { rect: frame.rect, shape: frame.shape, union: frame.union };
      if (handoff) handoff.current = displayedFrameRef.current;
      if (visibleRef.current) {
        applyRing();
      } else {
        visibleRef.current = true;
        setVisible(true);
      }
    };
    const showSettled = (frame: RingFrame, union: DisplayedRing['union'] = frame.union) =>
      show({ rect: frame.rect, shape: frame.shape, speeds: null, union });

    // Per-frame imperative loop: sample the tween's position and velocity, write
    // the DOM, and self-schedule — no React state, so a travelling ring never
    // reconciles.
    const tick = () => {
      rafRef.current = null;
      if (!activeRef.current) return;
      const tween = tweenRef.current;
      if (!tween) return;
      const now = performance.now();
      const { rect, shape, union, done } = sampleRingTween(tween, now);
      if (done) {
        // Settled: drop the tween so the final render is clean.
        tweenRef.current = null;
        showSettled({ rect, shape, union });
        return;
      }
      // Velocity comes from the tween's analytic derivative, so it is exact on the
      // FIRST frame — where the house ease-out is 4.5x its average speed and the
      // smear should be strongest. Finite-differencing rendered positions cannot
      // do that: it has no previous sample to difference on frame one, and that
      // frame alone covers ~31% of a 220ms travel.
      const speeds = union ? null : sampleRingVelocity(tween, now);

      frameRef.current = { rect, shape, speeds, union };
      displayedFrameRef.current = { rect, shape, union };
      if (handoff) handoff.current = displayedFrameRef.current;
      applyRing();
      rafRef.current = requestAnimationFrame(tick);
    };
    const scheduleTick = () => {
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(tick);
    };
    const cancelTick = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    const snapTo = (frame: RingFrame, identity: string, union?: DisplayedRing['union']) => {
      tweenRef.current = null;
      cancelTick();
      displayedIdentityRef.current = identity;
      showSettled(frame, union);
    };

    if (!active) {
      cancelTick();
      wasActiveRef.current = false;
      return;
    }

    if (!selectedId) {
      tweenRef.current = null;
      cancelTick();
      displayedIdentityRef.current = null;
      displayedFrameRef.current = null;
      frameRef.current = null;
      if (visibleRef.current) {
        visibleRef.current = false;
        setVisible(false);
      }
      return;
    }

    const identity = ringIdentity(selectedType, selectedId);
    // Evaluated once per effect run, not per frame — the effect re-runs on every
    // Lath commit, which is plenty fresh for an OS-preference toggle.
    const instant = motionIsInstant();

    const target = () => {
      if (isWorkspaceSelection(selectedType)) return workspaceTabElement(workspaceIdOfSelection(selectedType, selectedId));
      return selectedType === 'door' ? doorElements.get(selectedId) : resolvePaneElement(paneElements.get(selectedId));
    };
    // Wall selects the context source while a context is open, and renders one context per Wall.
    const helperEl = contextSourceId ? target()?.closest('.lath-host')?.querySelector<HTMLElement>('[data-context-for]') : null;
    const update = () => {
      if (!activeRef.current) return;
      const targetEl = target();
      if (!targetEl) return; // bail-and-hold: the leaf is momentarily absent

      const next = measureFrame(targetEl, selectedType);
      if (!next) return;
      const helperFrame = helperEl ? measureFrame(helperEl, 'pane') : null;
      const previous = frameRef.current;
      const union = helperFrame ? [next.rect, helperFrame.rect] as const : undefined;
      if (union) { next.rect = unionBounds(...union); next.union = union; }
      const wall = targetEl.closest<HTMLElement>('[data-workspace-wall]');
      opacityRef.current = wall?.style.opacity ?? '';

      // A newly visible Wall continues from the other Wall's painted frame,
      // never from its own stale selection history. Hidden Walls publish nothing.
      if (!wasActiveRef.current) {
        if (handoff?.current) {
          displayedFrameRef.current = handoff.current;
          displayedIdentityRef.current = null;
          tweenRef.current = null;
          showSettled(handoff.current);
        }
        wasActiveRef.current = true;
      }

      // Opening, repositioning and closing a helper morph both component
      // rectangles from the painted frame; never replace the union with a box.
      if (union || previous?.union || tweenRef.current?.from.union) {
        if (instant || !displayedFrameRef.current) { snapTo(next, identity, union); return; }
        const destination = tweenRef.current?.to ?? previous;
        if (destination && identity === displayedIdentityRef.current && framesEqual(destination, next)) return;
        tweenRef.current = startRingTween(displayedFrameRef.current, next, performance.now(), FOCUS_MOTION_MS);
        displayedIdentityRef.current = identity;
        scheduleTick();
        return;
      }
      // Snap gate: the same instant-motion predicate the Lath animator's
      // duration uses (motionIsInstant), so the ring and the leaves agree.
      if (instant) {
        snapTo(next, identity);
        return;
      }
      // Ring appearing (nothing shown yet) → snap; there is no `from` to glide
      // from. (snapTo/clear keep frame and identity in lockstep.)
      if (!displayedFrameRef.current) {
        snapTo(next, identity);
        return;
      }
      // Selection identity changed → tween from the current on-screen frame; the
      // clock restarts so rapid re-selection stays responsive.
      if (identity !== displayedIdentityRef.current) {
        tweenRef.current = startRingTween(displayedFrameRef.current, next, performance.now(), FOCUS_MOTION_MS);
        displayedIdentityRef.current = identity;
        scheduleTick();
        return;
      }
      // Same identity, tween in flight → retarget its destination (same clock),
      // so the ring converges on a moving target (select-neighbor-during-kill).
      if (tweenRef.current) {
        tweenRef.current = retargetRingTween(tweenRef.current, next);
        scheduleTick();
        return;
      }
      // Same identity, settled → track geometry 1:1 (sash drag, window resize).
      // Skip if unchanged so no-op store commits don't re-write the DOM.
      if (!framesEqual(displayedFrameRef.current, next)) {
        showSettled(next);
      }
    };

    update();

    const ro = new ResizeObserver(update);
    const targetEl = target();
    if (targetEl) ro.observe(targetEl);
    // The helper's per-frame placement is an inline style write, which a ResizeObserver misses.
    let mo: MutationObserver | undefined;
    if (helperEl) {
      ro.observe(helperEl);
      mo = new MutationObserver(update);
      mo.observe(helperEl, { attributes: true, attributeFilter: ['style'] });
    }
    window.addEventListener('resize', update);
    document.addEventListener('scroll', update, true);

    // While the wall streams animator frames the leaf divs carry the interpolated
    // inline geometry, so re-measuring each frame tracks the tween frame-accurately.
    const unsubFrames = subscribeLathFrames?.(() => update());
    const unsubWorkspaceFrames = subscribeWorkspaceMotionFrames(update);

    return () => {
      ro.disconnect();
      mo?.disconnect();
      unsubFrames?.();
      unsubWorkspaceFrames();
      window.removeEventListener('resize', update);
      document.removeEventListener('scroll', update, true);
    };
    // The rAF loop is intentionally NOT torn down here: it is keyed to the tween
    // (a ref), so a mid-glide re-run of this effect keeps the ring moving. It is
    // cancelled on selection-clear (above), on snap, and on unmount (below).
  }, [active, contextSourceId, handoff, workspaces, subscribeLathFrames, lathRevision, selectedId, selectedType, paneVersion, doorVersion, paneElements, doorElements, applyRing]);

  // After any structural render (mount, variant/color/focus change) re-apply the
  // current frame imperatively so the shell's DOM matches — runs pre-paint, so a
  // freshly mounted ring never flashes at unset geometry, and a variant change
  // re-derives the path/dash. Intentionally every-render: the per-frame rAF loop
  // bypasses React, so renders here are infrequent and re-applying is idempotent.
  useLayoutEffect(() => {
    applyRing();
  });

  // Cancel any in-flight rAF on unmount.
  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);

  if (!active || !visible || !selectedId) return null;

  const ring = (
    <SelectionRing
      variant={mode === 'passthrough' ? 'solid' : 'ants'}
      paused={renamingId !== null}
      color={selectionColor}
      windowFocused={windowFocused}
      containerRef={containerRef}
      pathRef={pathRef}
      smearRef={smearRef}
    />
  );
  // Fixed coordinates must not inherit the workspace presentation transform.
  return handoff ? createPortal(ring, document.body) : ring;
}
