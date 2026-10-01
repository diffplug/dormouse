import { afterEach, beforeEach } from 'vitest';

/**
 * Install a fake clock, `requestAnimationFrame`, and `matchMedia` around every
 * test in the calling file: `performance.now` reads the clock, frames run only
 * when a test advances it, and reduced motion is off until a test turns it on.
 * Call once at the top level of a test file.
 */
export function installFakeFrames() {
  let clock = 0;
  let seq = 0;
  let reduce = false;
  const queued = new Map<number, FrameRequestCallback>();
  let restore = () => {};

  beforeEach(() => {
    clock = 0;
    seq = 0;
    reduce = false;
    queued.clear();
    const real = {
      now: performance.now.bind(performance),
      raf: globalThis.requestAnimationFrame,
      caf: globalThis.cancelAnimationFrame,
      matchMedia: globalThis.matchMedia,
    };
    performance.now = () => clock;
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
      queued.set(++seq, callback);
      return seq;
    };
    globalThis.cancelAnimationFrame = (id: number) => { queued.delete(id); };
    globalThis.matchMedia = ((query: string) => ({
      matches: reduce && query.includes('prefers-reduced-motion'), media: query, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    })) as unknown as typeof matchMedia;
    restore = () => {
      performance.now = real.now;
      globalThis.requestAnimationFrame = real.raf;
      globalThis.cancelAnimationFrame = real.caf;
      globalThis.matchMedia = real.matchMedia;
    };
  });
  afterEach(() => restore());

  return {
    /** Frames queued and not yet run. */
    get pending(): number {
      return queued.size;
    },
    /** Advance the clock by `ms` and run the frames queued as of now; frames
     *  they queue wait for the next call. */
    advance(ms: number): void {
      clock += ms;
      const callbacks = [...queued.values()];
      queued.clear();
      for (const callback of callbacks) callback(clock);
    },
    /** Report the user's reduced-motion preference as `on`. */
    reduceMotion(on = true): void {
      reduce = on;
    },
  };
}
