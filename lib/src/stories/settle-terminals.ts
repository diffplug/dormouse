import { getActivitySnapshot, getTerminalInstance } from '../lib/terminal-registry';
import type { Terminal } from '@xterm/xterm';

/**
 * A Chromatic readiness gate for terminal-bearing stories.
 *
 * The FakePty adapter emits scenario data on a `setTimeout` (even `flattenScenario`'s
 * "instant" output is a `setTimeout(0)`), and xterm then parses and paints on its own
 * async schedule. A story with no `play` is snapshotted the moment React finishes
 * rendering — before that write lands — so the terminal is captured mid-paint (a
 * partial prompt like `user@dormo`). Chromatic awaits a story's `play` function, so
 * awaiting this in `play` holds the snapshot until every visible terminal has written
 * its content and painted a settled frame.
 *
 * Robustness rules (a hanging gate is worse than none — it stalls Chromatic to its
 * own timeout):
 *  - The poll clock is `setTimeout`, never `requestAnimationFrame` alone: rAF is
 *    fully paused in a hidden/backgrounded tab, so an rAF-only wait can hang forever.
 *  - Content is detected through the xterm BUFFER model (parsed synchronously on
 *    write), independent of which renderer (DOM / canvas / WebGL) is painting.
 *  - Every wait is bounded: the poll by `timeoutMs`, each paint wait by its own
 *    fallback timer, so the returned promise always resolves.
 */
export async function settleTerminals({ timeoutMs = 4000 }: { timeoutMs?: number } = {}): Promise<void> {
  const deadline = performance.now() + timeoutMs;

  // 1. Wait until at least one terminal exists and every live terminal has drawn
  //    content into its buffer (cursor advanced, or a non-blank cell) — the signal
  //    that the scenario data has actually been written, independent of adapter timers.
  while (performance.now() < deadline) {
    const terms = liveTerminals();
    if (terms.length > 0 && terms.every(hasContent)) break;
    await delay(16);
  }

  // 2. Give xterm's renderer a couple of frames to paint the settled buffer before
  //    the snapshot. Falls back to a timer so it never hangs if rAF is throttled.
  await paintFrame();
  await paintFrame();
}

/**
 * Wait until `predicate()` is true (bounded by `timeoutMs`), then a couple of paint
 * frames so whatever it gates has rendered. Companion to `settleTerminals` for stories
 * that reveal content asynchronously *after* the terminal paints — e.g. a programmatic
 * selection overlay applied on the story's own timer. Chaining it after
 * `settleTerminals` in `play` keeps Chromatic from capturing a painted terminal that
 * is still missing its overlay. Same robustness rules: `setTimeout` clock, bounded.
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

function liveTerminals(): Terminal[] {
  return [...getActivitySnapshot().keys()]
    .map((id) => getTerminalInstance(id))
    .filter((t): t is Terminal => t !== null);
}

function hasContent(term: Terminal): boolean {
  const buf = term.buffer.active;
  if (buf.cursorX > 0 || buf.cursorY > 0) return true;
  const line = buf.getLine(buf.cursorY);
  return !!line && line.translateToString(true).trim().length > 0;
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
