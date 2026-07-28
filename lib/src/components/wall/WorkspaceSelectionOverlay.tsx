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
import {
  SelectionRing,
  roundedRectPath,
  smearCornerPath,
  smearEdgePath,
  SMEAR_PIECES,
  type RingCorner,
  type RingEdge,
  type RingEdgeSpeeds,
} from './SelectionRing';

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

/** The frame the ring currently shows: geometry plus the per-edge motion-smear
 *  `speeds`, populated only while a tween runs; a settled ring carries null speeds,
 *  so its render is clean. Held in a ref and written to the DOM imperatively. */
interface DisplayedRing {
  rect: RingRect;
  shape: RingShape;
  speeds: RingEdgeSpeeds | null;
}

/** Which two edges each corner joins: `[vertical, horizontal]`, matching the
 *  `(a, b)` scale pair `smearCornerPath` blends between. */
const CORNER_EDGES: Record<RingCorner, [RingEdge, RingEdge]> = {
  tr: ['right', 'top'],
  br: ['right', 'bottom'],
  bl: ['left', 'bottom'],
  tl: ['left', 'top'],
};

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
  const smearRef = useRef<SVGGElement>(null);

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

  // Motion-smear inputs, sampled inside the rAF loop: the previous edge positions +
  // timestamp (the finite-difference source) and the EMA-smoothed per-edge speeds
  // that drive the smear. Both are cleared at tween start / on settle so a resting
  // ring renders with no smear at all (Chromatic determinism).
  const prevEdgesRef = useRef<{ top: number; right: number; bottom: number; left: number; t: number } | null>(null);
  const smoothedSpeedsRef = useRef<RingEdgeSpeeds | null>(null);

  /**
   * Draw the eight-piece motion smear underneath the ring, or hide it when the
   * ring is settled.
   *
   * Each edge smears only by its OWN motion across itself — an edge sliding
   * along its own length is unchanged — so the four edges are independent, and
   * collapsing them to one horizontal and one vertical speed gets common layouts
   * wrong. Moving between panes that are flush at the top but differ in height,
   * the top edge translates purely sideways (no perpendicular motion at all, so
   * it stays crisp) while the bottom edge moves diagonally and smears hard. A
   * ring-center velocity would average those into one wrong answer for both.
   *
   * Straight edges carry their width in a plain `stroke-width`. Corners cannot —
   * they have to reach two different widths at once — so each is stroked at unit
   * width and scaled, which tapers it between its neighbours (`smearCornerPath`).
   */
  const writeSmear = useCallback((
    rect: RingRect,
    shape: RingShape,
    inset: number,
    strokeWidth: number,
    speeds: RingEdgeSpeeds | null,
  ) => {
    const group = smearRef.current;
    if (!group) return;
    if (!speeds) {
      group.style.display = 'none';
      return;
    }
    group.style.display = '';

    const { smearGain, smearMaxPx } = cfg.focusRing;
    const maxScale = smearMaxPx / strokeWidth;
    // Width from this edge's own perpendicular speed; alpha conserves ink the way
    // a real smear does (spreading one stroke-width across N drops peak alpha to
    // 1/N) and fades in from zero, so an edge that is not moving contributes
    // nothing rather than laying a solid band under the ring.
    const band = (speed: number) => {
      const width = Math.min(smearMaxPx, strokeWidth + speed * smearGain);
      const scale = width / strokeWidth;
      const fade = maxScale > 1 ? Math.min(1, (scale - 1) / (maxScale - 1)) : 0;
      return { width, opacity: fade / scale };
    };
    const bands = {
      top: band(speeds.top),
      right: band(speeds.right),
      bottom: band(speeds.bottom),
      left: band(speeds.left),
    };

    const { width: w, height: h } = rect;
    const { tl, tr, br, bl } = shape;
    SMEAR_PIECES.forEach((piece, index) => {
      const el = group.children[index] as SVGPathElement | undefined;
      if (!el) return;
      if (piece === 'top' || piece === 'right' || piece === 'bottom' || piece === 'left') {
        const { width, opacity } = bands[piece];
        el.setAttribute('d', smearEdgePath(piece, w, h, tl, tr, br, bl, inset));
        el.setAttribute('stroke-width', `${width}`);
        el.setAttribute('stroke-opacity', `${opacity}`);
        el.removeAttribute('transform');
        return;
      }
      // Corner: `a` is the vertical neighbour's width, `b` the horizontal one, so
      // the unit stroke renders exactly each neighbour's width where it meets it.
      const [vertical, horizontal] = CORNER_EDGES[piece];
      const a = bands[vertical].width;
      const b = bands[horizontal].width;
      el.setAttribute('d', smearCornerPath(piece, w, h, tl, tr, br, bl, inset, a, b));
      el.setAttribute('stroke-width', '1');
      el.setAttribute('transform', `scale(${a} ${b})`);
      // Opacity cannot vary along a stroke, so a corner takes the mean of the two
      // edges it joins.
      el.setAttribute('stroke-opacity', `${(bands[vertical].opacity + bands[horizontal].opacity) / 2}`);
    });
  }, []);

  // Write the current frame to the DOM: container geometry, the ring path, the
  // marching-ants dash (command mode), and the directional smear. Reads
  // everything from refs so it is correct no matter which closure calls it (the rAF
  // tick, a snap, or the post-render re-apply below).
  const applyRing = useCallback(() => {
    const frame = frameRef.current;
    const container = containerRef.current;
    const path = pathRef.current;
    if (!frame || !container || !path) return;
    const { rect, shape, speeds } = frame;

    container.style.top = `${rect.top}px`;
    container.style.left = `${rect.left}px`;
    container.style.width = `${rect.width}px`;
    container.style.height = `${rect.height}px`;

    const isAnts = modeRef.current !== 'passthrough';
    const strokeWidth = isAnts ? cfg.marchingAnts.strokeWidth : 1;
    // Solid centers its 1px stroke a fixed strokeWidth/2 (0.5) inside the div edge —
    // pixel-parity with the retired CSS border; ants uses the shape's lerped inset.
    const effInset = isAnts ? shape.inset : strokeWidth / 2;

    path.setAttribute('d', roundedRectPath(rect.width, rect.height, shape.tl, shape.tr, shape.br, shape.bl, effInset));
    writeSmear(rect, shape, effInset, strokeWidth, speeds);

    if (isAnts) {
      // Dash sized to the perimeter so the segments stay even as the ring resizes.
      const len = path.getTotalLength();
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

  }, []);

  // Re-run the measuring effect after each Lath commit. Runs post-render, so
  // `getBoundingClientRect` sees the repositioned leaf divs.
  const lathRevision = useSyncExternalStore(lathStore.subscribe, () => lathStore.getSnapshot().revision);

  useEffect(() => {
    const resetMotionSamples = () => {
      prevEdgesRef.current = null;
      smoothedSpeedsRef.current = null;
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
      show({ rect: frame.rect, shape: frame.shape, speeds: null });

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
      // Finite-difference each EDGE's own perpendicular speed (px/ms), not the
      // ring center's velocity: a horizontal edge only smears by vertical motion
      // and a vertical edge only by horizontal motion, and the four edges of a
      // resizing rect move independently. Null on the first frame or a zero dt.
      const edges = {
        top: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        left: rect.left,
      };
      const prev = prevEdgesRef.current;
      const dt = prev ? now - prev.t : 0;
      const raw: RingEdgeSpeeds | null = prev && dt > 0
        ? {
          top: Math.abs(edges.top - prev.top) / dt,
          right: Math.abs(edges.right - prev.right) / dt,
          bottom: Math.abs(edges.bottom - prev.bottom) / dt,
          left: Math.abs(edges.left - prev.left) / dt,
        }
        : null;
      prevEdgesRef.current = { ...edges, t: now };

      // Low-pass the raw finite-difference speeds so rAF frame-timing jitter
      // doesn't make the smear pulse. Seeded from ZERO on purpose: the house
      // ease-out starts at peak speed, so a first-sample seed would pop the ring
      // from crisp to fully smeared in one frame — from zero, the smear swells in
      // over ~2 frames (imperceptible as lag at 60fps). A settled ring's null
      // speeds clear the smear.
      let speeds: RingEdgeSpeeds | null = null;
      if (raw) {
        const a = cfg.focusRing.smearSmoothing;
        const sm = smoothedSpeedsRef.current ?? { top: 0, right: 0, bottom: 0, left: 0 };
        speeds = {
          top: sm.top + (raw.top - sm.top) * a,
          right: sm.right + (raw.right - sm.right) * a,
          bottom: sm.bottom + (raw.bottom - sm.bottom) * a,
          left: sm.left + (raw.left - sm.left) * a,
        };
        smoothedSpeedsRef.current = speeds;
      }

      frameRef.current = { rect, shape, speeds };
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
      smearRef={smearRef}
    />
  );
}
