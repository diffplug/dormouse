import { useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
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
import { SelectionRing, type RingVelocity } from './SelectionRing';

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

/** The presentation frame the overlay renders: the tween's geometry plus the
 *  motion-blur `velocity`, which is populated only while a tween runs; a settled
 *  ring carries null velocity, so its render is always clean. */
interface DisplayedRing {
  rect: RingRect;
  shape: RingShape;
  velocity: RingVelocity | null;
}

/** True when two displayed frames are indistinguishable — same geometry AND both
 *  settled (no velocity). Used to skip redundant re-renders on a same-geometry
 *  re-measure; a moving frame never matches (its rect changes). */
function displayedEqual(a: DisplayedRing, b: DisplayedRing): boolean {
  return framesEqual(a, b) && !a.velocity && !b.velocity;
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
  const [displayed, setDisplayed] = useState<DisplayedRing | null>(null);

  // Refs survive the measuring effect's re-runs (lathRevision / paneVersion /
  // doorVersion): the ring's current on-screen frame (the tween's `from` on an
  // identity change), the identity it belongs to, the live tween, and the pending
  // rAF handle. The tween is a pure function of time (rect-tween.ts); this loop is
  // its only DOM/React driver.
  const displayedFrameRef = useRef<RingFrame | null>(null);
  const displayedIdentityRef = useRef<string | null>(null);
  const tweenRef = useRef<RingTween | null>(null);
  const rafRef = useRef<number | null>(null);

  // Motion-blur inputs, sampled inside the rAF loop: the previous center + timestamp
  // (finite-difference velocity source) and the EMA-smoothed velocity that drives
  // the directional blur. Both are cleared at tween start / on settle so a resting
  // ring renders with zero blur (Chromatic determinism).
  const prevCenterRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const smoothedVelRef = useRef<RingVelocity | null>(null);

  // Re-run the measuring effect after each Lath commit. Runs post-render, so
  // `getBoundingClientRect` sees the repositioned leaf divs.
  const lathRevision = useSyncExternalStore(lathStore.subscribe, () => lathStore.getSnapshot().revision);

  useEffect(() => {
    const commitDisplayed = (next: DisplayedRing) => {
      displayedFrameRef.current = { rect: next.rect, shape: next.shape };
      setDisplayed((prev) => (prev && displayedEqual(prev, next) ? prev : next));
    };
    // A settled (non-travelling) frame: geometry only, no motion treatment. Used by
    // snaps and same-identity re-measures.
    const commitSettled = (frame: RingFrame) =>
      commitDisplayed({ rect: frame.rect, shape: frame.shape, velocity: null });
    const resetMotionSamples = () => {
      prevCenterRef.current = null;
      smoothedVelRef.current = null;
    };

    // One `setState` per frame. Samples the live tween at wall-clock `now`, derives
    // the per-frame velocity + trail buffer for the experimental motion treatments,
    // clears the tween when it lands, and self-schedules until then.
    const tick = () => {
      rafRef.current = null;
      const tween = tweenRef.current;
      if (!tween) return;
      const now = performance.now();
      const { rect, shape, done } = sampleRingTween(tween, now);
      if (done) {
        // The ring has settled: drop the tween and motion samples so the final
        // render is clean (no blur).
        tweenRef.current = null;
        resetMotionSamples();
        commitSettled({ rect, shape });
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
      // doesn't make the blur pulse. Seeded from the first real sample (no ramp-up
      // lag); a settled ring's null velocity resets the filter.
      let velocity: RingVelocity | null = null;
      if (raw) {
        const a = cfg.focusRing.blurSmoothing;
        const sm = smoothedVelRef.current;
        velocity = sm
          ? { x: sm.x + (raw.x - sm.x) * a, y: sm.y + (raw.y - sm.y) * a }
          : raw;
        smoothedVelRef.current = velocity;
      }

      commitDisplayed({ rect, shape, velocity });
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
      commitSettled(frame);
    };

    if (!selectedId) {
      tweenRef.current = null;
      cancelTick();
      resetMotionSamples();
      displayedIdentityRef.current = null;
      displayedFrameRef.current = null;
      setDisplayed(null);
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
      // Same identity, settled → snap 1:1. Sash drags and window resizes track the
      // geometry exactly instead of easing behind it.
      commitSettled(next);
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
  }, [subscribeLathFrames, lathRevision, selectedId, selectedType, paneVersion, doorVersion, paneElements, doorElements]);

  // Cancel any in-flight rAF on unmount.
  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);

  if (!displayed || !selectedId) return null;

  const { rect, shape, velocity } = displayed;
  const style: CSSProperties = {
    position: 'fixed',
    pointerEvents: 'none',
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
    zIndex: 50,
    // The rect is driven per-frame by the JS tween; only the unfocus-saturate fade
    // rides a CSS transition (D7 — there is no layout transition left to drop).
    transition: `filter ${FOCUS_MOTION_MS}ms`,
    filter: windowFocused ? undefined : 'saturate(0.3)',
  };

  // One SVG ring for both modes: passthrough draws the 1px solid stroke that
  // replaced the old CSS border (pixel-identical placement); command draws the 2px
  // marching ants. The `velocity` channel drives the directional blur and is null on
  // a settled ring.
  return (
    <div style={style}>
      <SelectionRing
        variant={mode === 'passthrough' ? 'solid' : 'ants'}
        width={rect.width}
        height={rect.height}
        tl={shape.tl}
        tr={shape.tr}
        br={shape.br}
        bl={shape.bl}
        inset={shape.inset}
        color={selectionColor}
        paused={!windowFocused}
        velocity={velocity}
      />
    </div>
  );
}
