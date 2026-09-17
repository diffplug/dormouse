import { getActivitySnapshot, getTerminalInstance } from '../lib/terminal-registry';
import type { Terminal } from '@xterm/xterm';

/** How long each gate below waits before it gives up. */
const DEFAULT_TIMEOUT_MS = 4000;

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
 *
 * Throws rather than proceeding if the terminals never settle, like the gates below,
 * so the story fails in the Interactions panel instead of snapshotting mid-paint.
 */
export async function settleTerminals(opts?: { timeoutMs?: number }): Promise<void> {
  await waitForPrimedState(opts);
  const settled = () => {
    const terms = liveTerminals();
    return terms.length > 0 && terms.every(hasContent);
  };
  // Unlike the gates below, `settled` is not monotonic: a terminal that mounts
  // during `waitForCondition`'s trailing paint frames flips it back to false. So
  // re-poll until it holds after those frames, within the one budget.
  const deadline = performance.now() + (opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  do {
    await waitForCondition(settled, { timeoutMs: Math.max(0, deadline - performance.now()) });
  } while (!settled() && performance.now() < deadline);
  if (!settled()) {
    const terms = liveTerminals();
    throw new Error(terms.length === 0
      ? 'no terminal ever mounted'
      : `${terms.filter((t) => !hasContent(t)).length} of ${terms.length} terminals never wrote content`);
  }
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
 * Poll until `selector` matches an element that is at least partly on screen,
 * then return it.
 *
 * The counterpart to a play function's `querySelector(...)?.click()`: an element
 * that has not rendered yet makes the optional call a silent no-op, and the
 * story snapshots without whatever the play function was supposed to reveal —
 * intermittently, which reads as an unstable snapshot rather than a bug.
 * Rendering is not enough either: a story frame that collapses its content
 * leaves every element in the DOM, clipped to nothing, so the play function
 * passes over a blank snapshot. Throws with `what` in the message so the
 * Interactions panel names the missing piece.
 */
export async function requireElement<T extends Element = HTMLElement>(
  selector: string,
  what: string,
  opts?: { timeoutMs?: number },
): Promise<T> {
  // The first visible match, so a clipped sibling cannot mask it; else any match,
  // so the error below tells "never rendered" from "never on screen".
  const find = (): T | null => {
    const all = [...document.querySelectorAll<T>(selector)];
    return all.find((candidate) => visibleArea(candidate) > 0) ?? all[0] ?? null;
  };
  await waitForCondition(() => {
    const el = find();
    return !!el && visibleArea(el) > 0;
  }, opts);
  const el = find();
  if (!el) throw new Error(`${what} never rendered (${selector})`);
  if (visibleArea(el) <= 0) throw new Error(`${what} rendered but is never on screen: zero-size, hidden, or clipped away (${selector})`);
  return el;
}

/**
 * The area of `el` left after the viewport and every ancestor that clips it.
 *
 * An absolutely or fixed-positioned box escapes the overflow of ancestors below
 * its containing block, so those are skipped. Approximate by design: `clip-path`
 * and elements painted over it are not considered.
 */
function visibleArea(el: Element): number {
  const style = getComputedStyle(el);
  if (style.visibility !== 'visible' || !(el.checkVisibility?.() ?? true)) return 0;
  const rect = el.getBoundingClientRect();
  let left = Math.max(rect.left, 0);
  let top = Math.max(rect.top, 0);
  let right = Math.min(rect.right, window.innerWidth);
  let bottom = Math.min(rect.bottom, window.innerHeight);
  let position = style.position;
  for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const a = getComputedStyle(ancestor);
    if (a.display === 'contents') continue;
    const contains = position === 'fixed' ? containsFixed(a)
      : position === 'absolute' ? a.position !== 'static' || containsFixed(a)
      : true;
    if (!contains) continue;
    position = a.position;
    if (a.overflowX === 'visible' && a.overflowY === 'visible') continue;
    const bounds = ancestor.getBoundingClientRect();
    if (a.overflowX !== 'visible') {
      left = Math.max(left, bounds.left);
      right = Math.min(right, bounds.right);
    }
    if (a.overflowY !== 'visible') {
      top = Math.max(top, bounds.top);
      bottom = Math.min(bottom, bounds.bottom);
    }
  }
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

/** Whether a box with this style is the containing block of its fixed descendants. */
function containsFixed(style: CSSStyleDeclaration): boolean {
  return style.transform !== 'none'
    || style.perspective !== 'none'
    || style.filter !== 'none'
    || /\b(paint|layout|strict|content)\b/.test(style.contain);
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
  { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
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
