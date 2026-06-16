import { getPlatform } from '../../lib/platform';

export interface ScreenshotLoopDeps {
  getSession: () => string | undefined;
  getBinaryPath: () => string | undefined;
  isCapable: () => boolean;
  draw: (bitmap: ImageBitmap) => void;
}

export interface ScreenshotLoop {
  /** A "page changed" signal — schedule a fresh shot (coalesced + throttled). */
  pulse(): void;
  dispose(): void;
}

/**
 * Display crisp HiDPI screenshots, paced by stream-frame "pulses". The
 * screencast is CSS-resolution only (Chromium's `Page.startScreencast` ignores
 * deviceScaleFactor), so the panel uses its frames only as change signals and
 * displays device-resolution screenshots captured via the host.
 *
 * Backpressure (we only ever want the latest, and must slow down if capture
 * can't keep up): at most one screenshot in flight; a pulse during a shot sets
 * `dirty` (no queue — bursts collapse to one follow-up, latest wins); the next
 * shot won't start until at least one shot-duration (adaptive EWMA) has passed
 * since the last one began, so a slow capture self-throttles. A static page
 * produces no pulses, so no shots and no cost.
 */
export function createScreenshotLoop(deps: ScreenshotLoopDeps): ScreenshotLoop {
  let inFlight = false;
  let dirty = false;
  let seq = 0;
  let lastStart = 0;
  let avgMs = 120;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const display = (bytes: Uint8Array, mime: string, mySeq: number) => {
    // The bytes are ArrayBuffer-backed (readFile → structured clone); narrow off
    // the ArrayBufferLike default so they satisfy BlobPart.
    const part = bytes as Uint8Array<ArrayBuffer>;
    createImageBitmap(new Blob([part], { type: mime })).then((bitmap) => {
      // A newer shot landed first (or we're gone) — drop this one.
      if (disposed || mySeq !== seq) {
        bitmap.close();
        return;
      }
      deps.draw(bitmap);
    }).catch((err) => console.warn('[agent-browser] screenshot decode failed:', err));
  };

  const take = () => {
    const platform = getPlatform();
    const session = deps.getSession();
    if (!platform.agentBrowserScreenshot || !session) return;
    inFlight = true;
    dirty = false;
    const mySeq = ++seq;
    lastStart = performance.now();
    platform.agentBrowserScreenshot(session, { format: 'jpeg', quality: 85 }, deps.getBinaryPath()).then((res) => {
      avgMs = avgMs * 0.6 + (performance.now() - lastStart) * 0.4;
      inFlight = false;
      if (res.ok && res.bytes) display(res.bytes, res.mime || 'image/jpeg', mySeq);
      else console.warn('[agent-browser] screenshot failed:', res.error ?? '(no data)');
      if (dirty) schedule();
    }).catch((err) => {
      console.warn('[agent-browser] screenshot error:', err);
      inFlight = false;
      if (dirty) schedule();
    });
  };

  const schedule = () => {
    if (disposed) return;
    if (inFlight) {
      dirty = true;
      return;
    }
    // Space shots to ~1.5× the measured capture time since the last START: the
    // slower capture gets, the more we back off (≈⅔ duty cycle), and the 50ms
    // floor stops a fast/cached/error return from spinning a tight loop.
    const floor = Math.max(50, avgMs * 1.5);
    const wait = lastStart + floor - performance.now();
    if (wait > 0) {
      dirty = true;
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          if (dirty && !inFlight) take();
        }, wait);
      }
      return;
    }
    take();
  };

  return {
    pulse: () => {
      if (disposed || !deps.isCapable()) return;
      dirty = true;
      schedule();
    },
    dispose: () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
