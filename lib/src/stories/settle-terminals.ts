import { getActivitySnapshot, getTerminalInstance, refitSession } from '../lib/terminal-registry';
import type { Terminal } from '@xterm/xterm';

/**
 * A Chromatic readiness gate for terminal-bearing stories.
 *
 * A story with no `play` is snapshotted the moment React finishes rendering, so
 * awaiting this in `play` holds the snapshot until every visible terminal has both
 * (a) written its scenario content and (b) reached a settled grid geometry.
 *
 * Both halves matter:
 *  - Content: the FakePty adapter emits scenario data on a `setTimeout` (even
 *    `flattenScenario`'s "instant" output is a `setTimeout(0)`), and xterm parses
 *    it on write. Captured too early, the terminal shows a partial prompt.
 *  - Geometry: Lath tweens pane geometry across many animation frames on
 *    split/restore, and TerminalPane throttles its refit (150ms trailing edge),
 *    so a terminal's column count keeps changing *after* its content is in the
 *    buffer. Gating on content alone (the old behavior) let Chromatic snapshot a
 *    pane still laid out at a transitional width — `user@dormouse:~$` clipped to
 *    `user@do`. So we drive each terminal to its resting geometry (bypassing the
 *    throttle) and wait for the grid to hold steady before releasing the snapshot.
 *
 * Content is detected through the xterm BUFFER model (parsed synchronously on
 * write), independent of which renderer (DOM / canvas / WebGL) is painting.
 */

// A terminal's grid (cols×rows) must repeat unchanged this many consecutive polls
// before its geometry counts as settled. A single match isn't enough: mid-tween a
// column count can hold for a frame or two (an easing plateau, or a pixel change
// that hasn't yet crossed a cell boundary), so a short run of matches waits the
// motion out.
const STABLE_POLLS = 4;

export async function settleTerminals(opts?: { timeoutMs?: number }): Promise<void> {
  // Cell metrics are measured from the editor font; measuring before it is ready
  // yields the wrong column count. Resolves immediately when nothing is pending
  // (e.g. a system-monospace fallback), so it only ever costs a microtask.
  await documentFontsReady();

  const runs = new Map<string, { geom: string; count: number }>();
  await waitForCondition(() => {
    const terms = liveTerminals();
    if (terms.length === 0) return false;
    let allSettled = true;
    for (const { id, term } of terms) {
      if (!hasContent(term)) {
        allSettled = false;
        continue;
      }
      // Snap the terminal to its *current* resting container now rather than
      // waiting on the trailing throttled refit, so the reading below is the
      // final grid. fit() is a no-op when cols/rows already match, so a settled
      // terminal is only measured, not reflowed.
      refitSession(id);
      const geom = `${term.cols}x${term.rows}`;
      const prev = runs.get(id);
      const count = prev && prev.geom === geom ? prev.count + 1 : 1;
      runs.set(id, { geom, count });
      if (count < STABLE_POLLS) allSettled = false;
    }
    return allSettled;
  }, opts);

  await paintFrame();
  await paintFrame();
}

/**
 * Wait until `predicate()` is true (bounded by `timeoutMs`), then a couple of paint
 * frames so whatever it gates has rendered. The primitive behind `settleTerminals`,
 * and the direct tool for stories that reveal content asynchronously *after* the
 * terminal paints — e.g. a programmatic selection overlay applied on the story's own
 * timer, chained after `settleTerminals` so Chromatic never captures a painted
 * terminal that is still missing its overlay.
 *
 * Robustness rules (a hanging gate is worse than none — it stalls Chromatic to its
 * own timeout):
 *  - The poll clock is `setTimeout`, never `requestAnimationFrame` alone: rAF is
 *    fully paused in a hidden/backgrounded tab, so an rAF-only wait can hang forever.
 *  - Every wait is bounded: the poll by `timeoutMs`, each paint wait by its own
 *    fallback timer, so the returned promise always resolves.
 */
export async function waitForCondition(
  predicate: () => boolean,
  { timeoutMs = 4000 }: { timeoutMs?: number } = {},
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline && !predicate()) {
    await delay(16);
  }
  await paintFrame();
  await paintFrame();
}

function liveTerminals(): { id: string; term: Terminal }[] {
  return [...getActivitySnapshot().keys()]
    .map((id) => ({ id, term: getTerminalInstance(id) }))
    .filter((e): e is { id: string; term: Terminal } => e.term !== null);
}

function hasContent(term: Terminal): boolean {
  const buf = term.buffer.active;
  if (buf.cursorX > 0 || buf.cursorY > 0) return true;
  const line = buf.getLine(buf.cursorY);
  return !!line && line.translateToString(true).trim().length > 0;
}

/** Resolve once webfont loading has settled — immediately if the platform lacks
 *  the Font Loading API or has nothing pending, and bounded by a fallback timer so
 *  a font that never settles can't hang the gate (same doctrine as waitForCondition). */
function documentFontsReady(): Promise<void> {
  const fonts = document.fonts as FontFaceSet | undefined;
  if (!fonts) return Promise.resolve();
  return Promise.race([fonts.ready.then(() => undefined, () => undefined), delay(1000)]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One animation frame, or a short timer if rAF is paused — whichever comes first. */
function paintFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 100);
  });
}
