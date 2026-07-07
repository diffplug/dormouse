/**
 * Cap for scrollback stored in the persisted session snapshot. The live sidecar
 * buffer stays at its own (much larger) in-memory cap — only the persisted
 * snapshot is trimmed so N busy panes don't rewrite N MB on every save.
 */
export const PERSISTED_SCROLLBACK_MAX_CHARS = 100_000;

/**
 * Trim scrollback for persistence, keeping the tail.
 *
 * We keep the tail because restore replays recent output — the top of the
 * buffer is the least useful thing to keep when we have to drop something. We
 * cut at a line boundary so replay never shows a torn partial first line.
 * Tail-keeping also preserves the input's trailing `\n`, which restored
 * scrollback requires (see docs/specs/transport.md, "Scrollback trailing
 * newline").
 */
export function trimPersistedScrollback(scrollback: string, maxChars = PERSISTED_SCROLLBACK_MAX_CHARS): string {
  if (scrollback.length <= maxChars) return scrollback;
  const tail = scrollback.slice(-maxChars);
  const i = tail.indexOf('\n');
  // i === -1: one giant line, no boundary to cut on.
  // i === tail.length - 1: the only newline is the last char, so dropping
  // through it would return empty. Either way, keep the tail as a hard cut.
  if (i === -1 || i === tail.length - 1) return tail;
  return tail.slice(i + 1);
}
