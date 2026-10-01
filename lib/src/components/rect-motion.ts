// The copy editor's eased travel: an imperative rAF driver over the pure
// `RectTween` (rect-tween.ts). It keeps no React state; `write` puts each frame
// on the element directly, and `show` toggles its visibility.

import { FOCUS_MOTION_MS } from './design';
import { rectsEqual, sampleRectTween, startRectTween, type RectTween, type RingRect } from '../lib/rect-tween';
import { motionIsInstant } from '../lib/ui-geometry';

export interface RectMotion {
  /** Move toward `rect`: snap, showing the element, when nothing is shown or
   *  motion is instant, else ease from the displayed rect on a fresh clock. An
   *  equal target is a no-op. */
  setTarget(rect: RingRect): void;
  /** Stop, hide the element, and forget the displayed rect, so the next target
   *  snaps. A no-op while hidden. */
  hide(): void;
}

const roundRect = (r: RingRect): RingRect => ({
  top: Math.round(r.top),
  left: Math.round(r.left),
  width: Math.round(r.width),
  height: Math.round(r.height),
});

export function createRectMotion(o: {
  write(rect: RingRect): void;
  /** True after the first frame written since hiding, false on hiding. */
  show(visible: boolean): void;
}): RectMotion {
  let displayed: RingRect | null = null;
  let target: RingRect | null = null;
  let tween: RectTween | null = null;
  let frame: number | null = null;

  const cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  // Settled frames land on whole pixels; frames in flight stay fractional.
  const settle = (rect: RingRect) => {
    const hidden = !displayed;
    tween = null;
    displayed = roundRect(rect);
    o.write(displayed);
    if (hidden) o.show(true);
  };
  const tick = () => {
    frame = null;
    if (!tween) return;
    const { rect, done } = sampleRectTween(tween, performance.now());
    if (done) {
      settle(rect);
      return;
    }
    displayed = rect;
    o.write(rect);
    frame = requestAnimationFrame(tick);
  };

  return {
    setTarget(rect) {
      if (target && rectsEqual(target, rect)) return;
      target = rect;
      if (!displayed || motionIsInstant()) {
        cancel();
        settle(rect);
        return;
      }
      tween = startRectTween(displayed, rect, performance.now(), FOCUS_MOTION_MS);
      frame ??= requestAnimationFrame(tick);
    },
    hide() {
      cancel();
      tween = target = null;
      if (!displayed) return;
      displayed = null;
      o.show(false);
    },
  };
}
