import { getPlatform } from '../../lib/platform';

// Fast non-cryptographic hash (djb2, xor length) over the raw screenshot bytes —
// the byte analogue of the connection's frame dedup. A static page the daemon
// keeps re-pulsing produces byte-identical captures, so this lets us skip the
// decode+draw entirely.
function djb2Bytes(bytes: Uint8Array): number {
  let h = 5381;
  for (let i = 0; i < bytes.length; i++) h = ((h << 5) + h + bytes[i]) | 0;
  return (h ^ (bytes.length | 0)) | 0;
}

export interface ScreenshotLoopDeps {
  getSession: () => string | undefined;
  getBinaryPath: () => string | undefined;
  isCapable: () => boolean;
  draw: (bitmap: ImageBitmap) => void;
  /** A monotonic draw-target generation. Included in the byte-dedup key so a
   *  fresh canvas (bumped on re-attach) still repaints even when the bytes match
   *  the last displayed frame. Absent ⇒ generation 0 (dedup on bytes alone). */
  getDrawGeneration?: () => number;
  /** Monotonic count of provisional stream paints. A crisp capture whose start
   *  predates a newer provisional paint is stale and must not overwrite it. */
  getProvisionalGeneration?: () => number;
  /** `performance.now()` timestamp through which provisional stream paints are
   *  still expected (continued pointer input pushes it out). While it is in the
   *  future, a capture is certain to be superseded mid-flight and dropped, so the
   *  loop waits it out and takes one settled shot at the end instead of burning a
   *  host round trip per pulse. Absent ⇒ no window; capture on the pacing rule
   *  alone. */
  getProvisionalDeadline?: () => number;
  /** Optional gated logger for the high-rate per-shot start/done diagnostics;
   *  absent ⇒ silent. Warnings (stall/failure/error) stay unconditional. */
  log?: (message: string) => void;
}

export interface ScreenshotLoop {
  /** A "page changed" signal — schedule a fresh shot (coalesced + throttled). */
  pulse(): void;
  dispose(): void;
}

/**
 * Display crisp HiDPI screenshots, paced by stream-frame "pulses". The
 * screencast is CSS-resolution only (Chromium's `Page.startScreencast` ignores
 * deviceScaleFactor), so the panel paints it provisionally for responsiveness
 * and uses this loop to replace it with device-resolution host screenshots.
 *
 * Backpressure (we only ever want the latest, and must slow down if capture
 * can't keep up): at most one screenshot in flight; a pulse during a shot sets
 * `dirty` (no queue — bursts collapse to one follow-up, latest wins); the next
 * shot won't start until at least one shot-duration (adaptive EWMA) has passed
 * since the last one began, so a slow capture self-throttles. A static page
 * produces no pulses, so no shots and no cost.
 *
 * While the panel is painting provisional stream frames, a shot can't win the race
 * anyway (`getProvisionalDeadline`), so the loop waits the window out and takes one
 * settled shot at its end rather than one per pulse. Whatever the loop drops — a
 * deferred shot or one superseded mid-flight — it stays `dirty`, because the canvas
 * is left on a CSS-resolution frame and only a later crisp shot can sharpen it.
 */
export function createScreenshotLoop(deps: ScreenshotLoopDeps): ScreenshotLoop {
  let inFlight = false;
  let dirty = false;
  let seq = 0;
  let lastStart = 0;
  let avgMs = 120;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  // The `bytes:generation` of the frame currently on the canvas. Skips decoding a
  // capture we've already displayed onto this same draw target.
  let lastDrawnKey: string | null = null;

  const display = (bytes: Uint8Array, mime: string, mySeq: number, provisionalAtStart: number) => {
    // Identical bytes drawn onto the same canvas generation → nothing to repaint;
    // skip the decode. A fresh canvas bumps the generation, so the same bytes
    // still draw after a re-attach.
    const gen = deps.getDrawGeneration?.() ?? 0;
    const key = `${djb2Bytes(bytes)}:${gen}`;
    if (key === lastDrawnKey) return;
    // The bytes are ArrayBuffer-backed (readFile → structured clone); narrow off
    // the ArrayBufferLike default so they satisfy BlobPart.
    const part = bytes as Uint8Array<ArrayBuffer>;
    createImageBitmap(new Blob([part], { type: mime })).then((bitmap) => {
      // A newer shot landed first (or we're gone) — drop this one.
      if (
        disposed ||
        mySeq !== seq ||
        (deps.getProvisionalGeneration?.() ?? 0) !== provisionalAtStart
      ) {
        bitmap.close();
        return;
      }
      // Record only once actually drawn, so a shot dropped by the seq guard never
      // suppresses a later identical capture that must still paint.
      lastDrawnKey = key;
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
    const provisionalAtStart = deps.getProvisionalGeneration?.() ?? 0;
    lastStart = performance.now();
    deps.log?.(`[agent-browser] screenshot start ${JSON.stringify({ session, seq: mySeq })}`);
    // Watchdog: a capture that never resolves (a wedged host round-trip) must not
    // pin `inFlight` forever and silently freeze the screencast. Free the slot and
    // retry after a generous bound; a late resolve is dropped by the seq guard.
    let settled = false;
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      inFlight = false;
      console.warn(`[agent-browser] screenshot capture stalled (>8s) ${JSON.stringify({ session, seq: mySeq, dirty, willRetry: dirty })}`);
      if (dirty) schedule();
    }, 8000);
    platform.agentBrowserScreenshot(session, { format: 'jpeg', quality: 85 }, deps.getBinaryPath()).then((res) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      const elapsedMs = performance.now() - lastStart;
      deps.log?.(`[agent-browser] screenshot done ${JSON.stringify({ session, seq: mySeq, ok: res.ok, bytes: res.bytes?.byteLength ?? 0, elapsedMs: Math.round(elapsedMs), dirty })}`);
      avgMs = avgMs * 0.6 + elapsedMs * 0.4;
      inFlight = false;
      // A provisional stream frame painted during this capture is visibly newer.
      // Do not let the stale crisp result overwrite it. Mere `dirty` pulses do not
      // suppress drawing — an idle animated page still needs periodic crisp frames
      // even without pointer input.
      const stale = (deps.getProvisionalGeneration?.() ?? 0) !== provisionalAtStart;
      if (res.ok && res.bytes) {
        if (stale) {
          // Dropping the result leaves CSS-resolution pixels on the canvas, and the
          // stream owes us nothing more: a single pointer move over a static page
          // pulses once, and that pulse was consumed by this very capture. Keep the
          // work pending so the resting frame still sharpens.
          dirty = true;
        } else {
          display(res.bytes, res.mime || 'image/jpeg', mySeq, provisionalAtStart);
        }
      } else {
        console.warn('[agent-browser] screenshot failed:', res.error ?? '(no data)');
      }
      if (dirty) schedule();
    }).catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      console.warn(`[agent-browser] screenshot error ${JSON.stringify({ session, seq: mySeq })}:`, err);
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
    const now = performance.now();
    // Two independent reasons to wait; the longer wins.
    //
    // Pacing: space shots to ~1.5× the measured capture time since the last START.
    // The slower capture gets, the more we back off (≈⅔ duty cycle), and the 50ms
    // floor stops a fast/cached/error return from spinning a tight loop.
    const paceWait = lastStart + Math.max(50, avgMs * 1.5) - now;
    // Provisional window: while stream paints are still landing (~20Hz) any capture
    // (~120ms) is superseded before it resolves, so every one of them is a host
    // round trip whose bytes we throw away. The dropped shots were never drawing
    // anything, so skipping them costs no pixels — the frame that actually lands is
    // the first one started after the last provisional paint either way.
    const provisionalWait = (deps.getProvisionalDeadline?.() ?? 0) - now;
    const wait = Math.max(paceWait, provisionalWait);
    if (wait > 0) {
      dirty = true;
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          // Re-enter `schedule`, not `take`: continued pointer input pushes the
          // provisional window past this timer, and re-checking re-arms for the new
          // end instead of spending a shot that window would supersede.
          if (dirty && !inFlight) schedule();
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
