import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
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
  startRingTween,
  type RingFrame,
  type RingRect,
  type RingShape,
  type RingTween,
} from '../../lib/rect-tween';
import { useFocusRingColor } from '../../lib/themes/use-focus-ring-color';
import { resolvePaneElement } from './resolve-pane-element';
import type { WallMode, WallSelectionKind } from './wall-types';
import { DoorElementsContext, PaneElementsContext, WindowFocusedContext } from './wall-context';
import { SelectionRing, roundedRectPath, type RingVelocity } from './SelectionRing';

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
 *  door edge (inset = strokeWidth / 2). Radii + inset ride the tween so a pane↔door
 *  selection morphs its shape instead of popping. */
function ringShape(isDoor: boolean): RingShape {
  if (isDoor) {
    const r = TERMINAL_BORDER_RADIUS_PX;
    return { tl: r, tr: r, br: 0, bl: 0, inset: cfg.marchingAnts.strokeWidth / 2 };
  }
  const r = PANE_SELECTION_RING_RADIUS_PX;
  return { tl: r, tr: r, br: r, bl: r, inset: SELECTION_RING_INFLATE_PX - PANE_GUTTER_PX / 2 };
}

function measureFrame(el: HTMLElement, isDoor: boolean): RingFrame {
  const r = el.getBoundingClientRect();
  const inflate = isDoor ? 0 : SELECTION_RING_INFLATE_PX;
  return {
    rect: {
      top: r.top - inflate,
      left: r.left - inflate,
      width: r.width + inflate * 2,
      height: r.height + inflate * 2,
    },
    shape: ringShape(isDoor),
  };
}

function framesEqual(a: RingFrame, b: RingFrame): boolean {
  return (
    a.rect.top === b.rect.top && a.rect.left === b.rect.left
    && a.rect.width === b.rect.width && a.rect.height === b.rect.height
    && a.shape.tl === b.shape.tl && a.shape.tr === b.shape.tr
    && a.shape.br === b.shape.br && a.shape.bl === b.shape.bl
    && a.shape.inset === b.shape.inset
  );
}

/** The frame the ring currently shows: geometry plus the motion-smear `velocity`,
 *  which is populated only while a tween runs; a settled ring carries null velocity,
 *  so its render is clean. Held in a ref and written to the DOM imperatively. */
interface DisplayedRing {
  rect: RingRect;
  shape: RingShape;
  velocity: RingVelocity | null;
}

export function WorkspaceSelectionOverlay({ lathStore, subscribeLathFrames, selectedId, selectedType, mode }: {
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
}) {
  const { elements: paneElements, version: paneVersion } = useContext(PaneElementsContext);
  const { elements: doorElements, version: doorVersion } = useContext(DoorElementsContext);
  const selectionColor = useFocusRingColor();
  const windowFocused = useContext(WindowFocusedContext);

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

  // Latest values the imperative writer reads. `frameRef` is the frame on screen;
  // `modeRef` mirrors the current mode so any `applyRing` closure derives the right
  // variant without a stale capture.
  const frameRef = useRef<DisplayedRing | null>(null);
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

  // Motion-smear inputs, sampled inside the rAF loop: the previous center + timestamp
  // (finite-difference velocity source) and the EMA-smoothed velocity that drives
  // the directional smear. Both are cleared at tween start / on settle so a resting
  // ring renders with no smear at all (Chromatic determinism).
  const prevCenterRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const smoothedVelRef = useRef<RingVelocity | null>(null);

  // Write the current frame to the DOM: container geometry, the ring path, the
  // marching-ants dash (command mode), and the directional smear. Reads
  // everything from refs so it is correct no matter which closure calls it (the rAF
  // tick, a snap, or the post-render re-apply below).
  const applyRing = useCallback(() => {
    const frame = frameRef.current;
    const container = containerRef.current;
    const path = pathRef.current;
    if (!frame || !container || !path) return;
    const { rect, shape, velocity } = frame;

    container.style.top = `${rect.top}px`;
    container.style.left = `${rect.left}px`;
    container.style.width = `${rect.width}px`;
    container.style.height = `${rect.height}px`;

    const isAnts = modeRef.current !== 'passthrough';
    const strokeWidth = isAnts ? cfg.marchingAnts.strokeWidth : 1;
    // Solid centers its 1px stroke a fixed strokeWidth/2 (0.5) inside the div edge —
    // pixel-parity with the retired CSS border; ants uses the shape's lerped inset.
    const effInset = isAnts ? shape.inset : strokeWidth / 2;

    // Directional motion smear. A moving line smears PERPENDICULAR to its travel:
    // a vertical edge sliding sideways sweeps into a band, while a horizontal edge
    // sliding sideways just slides along itself and barely changes. So horizontal
    // speed widens the vertical edges and vice versa. Under `scale(sx, sy)` a
    // vertical stroke's width is measured in x (scales by sx) and a horizontal
    // stroke's in y (sy), which is exactly that mapping — and the counter-scaled
    // path keeps the on-screen geometry pixel-identical (see `roundedRectPath`).
    //
    // This replaces an SVG `feGaussianBlur`. Same physical effect, but WebKit
    // CPU-rasterizes SVG filters every frame: measured on the website playground,
    // the filter cost 25.6ms/frame with 31 of 98 frames over 25ms during travel,
    // versus a locked 16.7ms/0-dropped without it. A scale transform and a stroke
    // opacity are GPU-composited and cost nothing.
    const { smearGain, smearMaxPx } = cfg.focusRing;
    let sx = 1;
    let sy = 1;
    let strokeOpacity = 1;
    if (velocity) {
      const widthFor = (v: number) =>
        Math.min(smearMaxPx, strokeWidth + Math.abs(v) * smearGain);
      const wx = widthFor(velocity.x);
      const wy = widthFor(velocity.y);
      sx = wx / strokeWidth;
      sy = wy / strokeWidth;
      // Conserve ink the way a real smear does: spreading one stroke-width of
      // color across N drops peak alpha to 1/N. Without this the ring reads as a
      // border that briefly got thick rather than as something moving fast.
      strokeOpacity = 1 / Math.max(sx, sy);
    }
    path.setAttribute('d', roundedRectPath(rect.width, rect.height, shape.tl, shape.tr, shape.br, shape.bl, effInset, sx, sy));
    // A settled ring carries no transform at all, so it is byte-identical to the
    // pre-smear output (Chromatic determinism).
    if (velocity) {
      path.setAttribute('transform', `scale(${sx} ${sy})`);
      path.setAttribute('stroke-opacity', `${strokeOpacity}`);
    } else {
      path.removeAttribute('transform');
      path.removeAttribute('stroke-opacity');
    }

    if (isAnts) {
      // Dash sized to the perimeter so the segments stay even as the ring resizes.
      const len = path.getTotalLength();
      const count = Math.max(1, Math.round(len / cfg.marchingAnts.segLen));
      const adjusted = len / count;
      // Dissolve the ants into a solid streak as the smear grows. Under
      // scale(sx, sy) an edge's dash length and its thickness ride DIFFERENT
      // axes (a horizontal edge's length scales by sx, its thickness by sy), so
      // a fully smeared edge renders a 6px dash 6px thick — square beads, not
      // ants. The two edge families want reciprocal corrections, so no single
      // stroke-dasharray can hold the 3:1 aspect on both; rather than fight
      // that, close the gaps. That is also what a real smear does to the edge
      // running PARALLEL to the travel (its dashes slide into each other), so
      // both families end up consistent.
      //
      // The dash PERIOD is deliberately untouched: `--march-offset` must stay
      // exactly one dash+gap or the `marching-ants` keyframe jumps every cycle.
      // Scaling the period with the smear instead would swing it 10→30px
      // mid-travel, and since dash boundaries sit at integer multiples of the
      // period measured from the path start, that slides far-side dashes ~50px
      // in a single frame — the ants visibly stream around the perimeter.
      const smearScale = Math.max(sx, sy);
      const maxScale = smearMaxPx / strokeWidth;
      const dissolve = maxScale > 1 ? Math.min(1, (smearScale - 1) / (maxScale - 1)) : 0;
      const dashFraction = cfg.marchingAnts.dashFraction
        + (1 - cfg.marchingAnts.dashFraction) * dissolve;
      const dash = adjusted * dashFraction;
      // Subtract rather than recompute, so `dash + gap === adjusted` exactly —
      // that equality is the `--march-offset` contract.
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

  }, []);

  // Re-run the measuring effect after each Lath commit. Runs post-render, so
  // `getBoundingClientRect` sees the repositioned leaf divs.
  const lathRevision = useSyncExternalStore(lathStore.subscribe, () => lathStore.getSnapshot().revision);

  useEffect(() => {
    const resetMotionSamples = () => {
      prevCenterRef.current = null;
      smoothedVelRef.current = null;
    };
    // Show a frame: record it, then either apply it now (already mounted) or mount
    // the shell (the post-render layout effect applies it before paint).
    const show = (frame: DisplayedRing) => {
      frameRef.current = frame;
      displayedFrameRef.current = { rect: frame.rect, shape: frame.shape };
      if (visibleRef.current) {
        applyRing();
      } else {
        visibleRef.current = true;
        setVisible(true);
      }
    };
    const showSettled = (frame: RingFrame) =>
      show({ rect: frame.rect, shape: frame.shape, velocity: null });

    // Per-frame imperative loop: sample the tween, derive the smoothed blur
    // velocity, write the DOM, and self-schedule — no React state, so a travelling
    // ring never reconciles.
    const tick = () => {
      rafRef.current = null;
      const tween = tweenRef.current;
      if (!tween) return;
      const now = performance.now();
      const { rect, shape, done } = sampleRingTween(tween, now);
      if (done) {
        // Settled: drop the tween and motion samples so the final render is clean.
        tweenRef.current = null;
        resetMotionSamples();
        showSettled({ rect, shape });
        return;
      }
      // Finite-difference velocity of the ring center (px/ms); null on the first
      // frame or a zero dt.
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const prev = prevCenterRef.current;
      const dt = prev ? now - prev.t : 0;
      const raw: RingVelocity | null = prev && dt > 0
        ? { x: (cx - prev.x) / dt, y: (cy - prev.y) / dt }
        : null;
      prevCenterRef.current = { x: cx, y: cy, t: now };

      // Low-pass the raw finite-difference velocity so rAF frame-timing jitter
      // doesn't make the smear pulse. Seeded from ZERO on purpose: the house
      // ease-out starts at peak speed, so a first-sample seed would pop the ring
      // from crisp to fully smeared in one frame — from zero, the smear swells in
      // over ~2 frames (imperceptible as lag at 60fps). A settled ring's null
      // velocity clears the smear.
      let velocity: RingVelocity | null = null;
      if (raw) {
        const a = cfg.focusRing.smearSmoothing;
        const sm = smoothedVelRef.current ?? { x: 0, y: 0 };
        velocity = { x: sm.x + (raw.x - sm.x) * a, y: sm.y + (raw.y - sm.y) * a };
        smoothedVelRef.current = velocity;
      }

      frameRef.current = { rect, shape, velocity };
      displayedFrameRef.current = { rect, shape };
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
    const snapTo = (frame: RingFrame, identity: string) => {
      tweenRef.current = null;
      cancelTick();
      resetMotionSamples();
      displayedIdentityRef.current = identity;
      showSettled(frame);
    };

    if (!selectedId) {
      tweenRef.current = null;
      cancelTick();
      resetMotionSamples();
      displayedIdentityRef.current = null;
      displayedFrameRef.current = null;
      frameRef.current = null;
      if (visibleRef.current) {
        visibleRef.current = false;
        setVisible(false);
      }
      return;
    }

    const isDoor = selectedType === 'door';
    const identity = `${selectedType}:${selectedId}`;
    // Evaluated once per effect run, not per frame — the effect re-runs on every
    // Lath commit, which is plenty fresh for an OS-preference toggle.
    const instant = motionIsInstant();

    const update = () => {
      const targetEl = isDoor
        ? doorElements.get(selectedId)
        : resolvePaneElement(paneElements.get(selectedId));
      if (!targetEl) return; // bail-and-hold: the leaf is momentarily absent

      const next = measureFrame(targetEl, isDoor);

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
      // clock restarts (and motion samples reset) so rapid re-selection stays
      // responsive and the new travel's velocity starts fresh.
      if (identity !== displayedIdentityRef.current) {
        resetMotionSamples();
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
    const panelEl = resolvePaneElement(paneElements.get(selectedId));
    if (panelEl) ro.observe(panelEl);
    const doorEl = doorElements.get(selectedId);
    if (doorEl) ro.observe(doorEl);

    // While the wall streams animator frames the leaf divs carry the interpolated
    // inline geometry, so re-measuring each frame tracks the tween frame-accurately.
    const unsubFrames = subscribeLathFrames?.(() => update());

    return () => { ro.disconnect(); unsubFrames?.(); };
    // The rAF loop is intentionally NOT torn down here: it is keyed to the tween
    // (a ref), so a mid-glide re-run of this effect keeps the ring moving. It is
    // cancelled on selection-clear (above), on snap, and on unmount (below).
  }, [subscribeLathFrames, lathRevision, selectedId, selectedType, paneVersion, doorVersion, paneElements, doorElements, applyRing]);

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

  if (!visible || !selectedId) return null;

  return (
    <SelectionRing
      variant={mode === 'passthrough' ? 'solid' : 'ants'}
      color={selectionColor}
      windowFocused={windowFocused}
      containerRef={containerRef}
      pathRef={pathRef}
    />
  );
}
