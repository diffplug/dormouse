import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "dormouse-lib/lib/ui-geometry";

const PocketDemo = lazy(() => import("./PocketDemo"));

/** The phone's layout width: a real phone's, so Pocket's bars fit their labels. */
const PHONE_WIDTH = 390;
/** Viewport height the phone leaves free: the site header and some air. */
const PHONE_VIEWPORT_MARGIN = 140;
/** Turned toward the text, as a photographed phone would be, through a long
 *  lens (a far vanishing point), so it does not distort. */
const PHONE_TURN = "perspective(6000px) rotateY(16deg) rotateX(6deg) rotateZ(-2deg)";

/** The size of a `width`×`height` box turned by `PHONE_TURN` about its center. */
function turnedSize(width: number, height: number): { width: number; height: number } {
  const turn = new DOMMatrix(PHONE_TURN);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
    const point = turn.transformPoint(new DOMPoint((x * width) / 2, (y * height) / 2));
    return [point.x / point.w, point.y / point.w];
  });
  const span = (axis: 0 | 1) => Math.max(...corners.map((c) => c[axis])) - Math.min(...corners.map((c) => c[axis]));
  return { width: span(0), height: span(1) };
}

/** The real Pocket UI playing a script in a phone frame. It lays out at a
 *  phone's width and scales down to fit one screen and its column. It mounts a
 *  screen ahead, so the phone is already on when it scrolls in; its script
 *  starts once a third of the phone is on screen, and once it has scrolled
 *  away the demo remounts, so it starts over on return. */
export function PocketDemoPhone({ className = "" }: { className?: string }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const phoneRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [run, setRun] = useState(0);
  const restart = useCallback(() => setRun((count) => count + 1), []);
  const [fit, setFit] = useState<{ scale: number; height: number; top: number } | null>(null);
  useEffect(() => {
    const slot = slotRef.current;
    const phone = phoneRef.current;
    if (!slot || !phone) return;
    const nearby = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setNear(true);
      nearby.disconnect();
    }, { rootMargin: "100% 0px" });
    nearby.observe(slot);
    let played = false;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.intersectionRatio >= 0.35) {
        played = true;
        setPlaying(true);
      } else if (!entry.isIntersecting && played) {
        played = false;
        setPlaying(false);
        restart();
      }
    }, { threshold: [0, 0.35] });
    observer.observe(slot);
    // The layout box ignores transforms, so its turned size is fixed.
    const turned = turnedSize(PHONE_WIDTH, phone.offsetHeight);
    const refit = () => {
      const scale = Math.min(1, slot.clientWidth / turned.width, (window.innerHeight - PHONE_VIEWPORT_MARGIN) / turned.height);
      // Turned about its center, so centering the layout box centers the projection.
      setFit((prev) => prev?.scale === scale ? prev : { scale, height: turned.height * scale, top: (turned.height * scale - phone.offsetHeight) / 2 });
    };
    refit();
    window.addEventListener("resize", refit);
    return () => {
      nearby.disconnect();
      observer.disconnect();
      window.removeEventListener("resize", refit);
    };
  }, [restart]);
  return (
    <div
      ref={slotRef}
      role="img"
      aria-label="Dormouse Pocket on a phone: a request typed to a coding agent, its question answered with two gestures, then the README it changed, with a 3D cheese wedge turning in it"
      className={`relative w-full ${className}`}
      // Unfitted (prerendered), the slot holds the phone's natural proportions.
      style={{ maxWidth: PHONE_WIDTH, ...(fit ? { height: fit.height } : { aspectRatio: `${PHONE_WIDTH} / 750` }) }}
    >
      <div
        ref={phoneRef}
        className="absolute left-1/2 rounded-[2rem] border border-white/15 bg-neutral-950 px-3 pb-6 pt-4"
        style={{
          width: PHONE_WIDTH,
          marginLeft: -PHONE_WIDTH / 2,
          top: fit?.top ?? 0,
          // The stacked shadows read as its near edge's thickness.
          transform: `scale(${fit?.scale ?? 1}) ${PHONE_TURN}`,
          boxShadow: "-3px 3px 0 #3a3a3c, -6px 6px 0 #2a2a2c, -8px 8px 0 #1c1c1e, -30px 40px 90px rgba(0,0,0,0.6)",
        }}
      >
        <div className="mx-auto mb-3 h-1.5 w-24 rounded-full bg-white/20" />
        <div className="aspect-[390/760] overflow-hidden rounded-[1.25rem] border border-white/10 bg-black">
          <div className="h-full" aria-hidden="true" inert>
            {near ? (
              <Suspense fallback={null}>
                <PocketDemo key={run} playing={playing} onStuck={restart} still={prefersReducedMotion()} />
              </Suspense>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
