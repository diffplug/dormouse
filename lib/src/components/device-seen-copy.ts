/**
 * When a paired browser was paired and last seen, in the words both of its lists
 * use: Settings' on the computer, and Pocket's on the phone.
 */

/** `today`, or a short date — with its year only when it is not this one. */
export function dayOf(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return 'today';
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/**
 * `null` is a log with nothing about this browser — one paired before the log
 * existed, or since trimmed out of it — not proof it never connected.
 */
export function lastSeenText(lastSeenAt: number | null, now: number): string {
  if (lastSeenAt === null) return 'Not in the access log';
  const ago = now - lastSeenAt;
  if (ago < 60_000) return 'Last seen just now';
  if (ago < 60 * 60_000) return `Last seen ${Math.floor(ago / 60_000)} min ago`;
  if (ago < 24 * 60 * 60_000) return `Last seen ${Math.floor(ago / (60 * 60_000))} h ago`;
  return `Last seen ${dayOf(lastSeenAt, now)}`;
}
