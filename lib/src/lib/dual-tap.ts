/** The last keydown, when it was a left Meta or Shift that can start the gesture. */
export interface DualTapState {
  left: { key: string; time: number } | null;
}

export function newDualTapState(): DualTapState {
  return { left: null };
}

/**
 * Feed every keydown; true when it completes the leader gesture: left-then-right
 * Meta, or Shift, less than 500 ms apart. Any other key in between, the other
 * modifier included, cancels it: a left-Shift capital, a word, then a
 * right-Shift capital is typing.
 *
 * The iframe shim embeds this function's source (iframe-proxy-rewrite.ts), so it
 * must stay self-contained: no imports, no module-scope references, no syntax a
 * bundler lowers to a helper, no inner named functions.
 */
export function dualTap(s: DualTapState, e: { key: string; location: number }): boolean {
  const left = s.left;
  s.left = null;
  if (e.key !== 'Meta' && e.key !== 'Shift') return false;
  const now = Date.now();
  if (e.location === 1) {
    s.left = { key: e.key, time: now };
    return false;
  }
  return left !== null && left.key === e.key && now - left.time < 500;
}
