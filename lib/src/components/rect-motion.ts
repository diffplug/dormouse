// The copy editor's eased travel: an imperative rAF driver over the pure
// `RectTween` (rect-tween.ts), modelled on WorkspaceSelectionOverlay's loop. It
// keeps no React state; `write` puts each frame on the element directly.

import { FOCUS_MOTION_MS } from './design';
import { sampleRectTween, startRectTween, type RectTween, type RingRect } from '../lib/rect-tween';
import { motionIsInstant } from '../lib/ui-geometry';

export interface RectMotion {
  /** Move toward `rect`: snap when nothing is shown or motion is instant, else
   *  ease from the displayed rect on a fresh clock. An equal target is a no-op. */
  setTarget(rect: RingRect): void;
  /** Stop and forget the displayed rect, so the next target snaps. Writes
   *  nothing; the caller hides the element. */
  hide(): void;
  /** Cancel any pending frame; later calls do nothing. */
  dispose(): void;
}

const rectsEqual = (a: RingRect, b: RingRect) =>
  a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;

const roundRect = (r: RingRect): RingRect => ({
  top: Math.round(r.top),
  left: Math.round(r.left),
  width: Math.round(r.width),
  height: Math.round(r.height),
});

export function createRectMotion(o: {
  write(rect: RingRect): void;
  now?: () => number;
  raf?: (callback: FrameRequestCallback) => number;
  caf?: (handle: number) => void;
  durationMs?: number;
}): RectMotion {
  const now = o.now ?? (() => performance.now());
  const raf = o.raf ?? ((callback) => requestAnimationFrame(callback));
  const caf = o.caf ?? ((handle) => cancelAnimationFrame(handle));
  let displayed: RingRect | null = null;
  let target: RingRect | null = null;
  let tween: RectTween | null = null;
  let frame: number | null = null;
  let disposed = false;

  const cancel = () => {
    if (frame !== null) caf(frame);
    frame = null;
  };
  // Settled frames land on whole pixels; frames in flight stay fractional.
  const settle = (rect: RingRect) => {
    tween = null;
    displayed = roundRect(rect);
    o.write(displayed);
  };
  const tick = () => {
    frame = null;
    if (!tween) return;
    const { rect, done } = sampleRectTween(tween, now());
    if (done) {
      settle(rect);
      return;
    }
    displayed = rect;
    o.write(rect);
    frame = raf(tick);
  };

  return {
    setTarget(rect) {
      if (disposed || (target && rectsEqual(target, rect))) return;
      target = rect;
      if (!displayed || motionIsInstant()) {
        cancel();
        settle(rect);
        return;
      }
      tween = startRectTween(displayed, rect, now(), o.durationMs ?? FOCUS_MOTION_MS);
      frame ??= raf(tick);
    },
    hide() {
      cancel();
      tween = displayed = target = null;
    },
    dispose() {
      cancel();
      tween = null;
      disposed = true;
    },
  };
}
