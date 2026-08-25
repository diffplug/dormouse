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
 * Content is detected through the xterm BUFFER model (parsed synchronously on write),
 * independent of which renderer (DOM / canvas / WebGL) is painting.
 */
export async function settleTerminals(opts?: { timeoutMs?: number }): Promise<void> {
  await waitForPrimedState(opts);
  await waitForCondition(() => {
    const terms = liveTerminals();
    return terms.length > 0 && terms.every(hasContent);
  }, opts);
}

/**
 * Hold until the preview's primed-state decorator has applied.
 *
 * Priming (activity status, TODO, notification, WATCHING rules) lands two rAFs
 * after mount, so a play function driving the header on a fixed timer can act on
 * the pre-primed DOM: focusing a TODO pill that has not rendered yet, or opening
 * a dialog whose content — and the one-shot viewport clamp measured from it —
 * then changes underneath it. `preview.ts` marks the document root when the
 * decorator has run; this is the matching gate.
 *
 * Throws rather than proceeding, so a story that would have snapshotted the
 * pre-primed state fails visibly in the Interactions panel instead.
 */
export async function waitForPrimedState(opts?: { timeoutMs?: number }): Promise<void> {
  const primed = () => document.documentElement.dataset.storyPrimed === 'true';
  await waitForCondition(primed, opts);
  if (!primed()) throw new Error('story state was never primed');
}

/**
 * Poll until `selector` matches, then return the element.
 *
 * The counterpart to a play function's `querySelector(...)?.click()`: an element
 * that has not rendered yet makes the optional call a silent no-op, and the
 * story snapshots without whatever the play function was supposed to reveal —
 * intermittently, which reads as an unstable snapshot rather than a bug. Throws
 * with `what` in the message so the Interactions panel names the missing piece.
 */
export async function requireElement<T extends Element = HTMLElement>(
  selector: string,
  what: string,
  opts?: { timeoutMs?: number },
): Promise<T> {
  await waitForCondition(() => !!document.querySelector(selector), opts);
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`${what} never rendered (${selector})`);
  return el;
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
