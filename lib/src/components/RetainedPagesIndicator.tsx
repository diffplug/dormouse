import { GaugeIcon } from '@phosphor-icons/react';

/**
 * Minimized iframe pages are never evicted or reloaded (#610), so each keeps
 * its memory, scripts and sockets while nobody sees it. Past this many on one
 * Baseboard, it says so — the old parking cap, so a user who never hit it
 * never sees this.
 */
export const RETAINED_PAGES_WARN_ABOVE = 8;

/**
 * A quiet count in the Baseboard's right cluster once more minimized pages
 * stay live than `RETAINED_PAGES_WARN_ABOVE` (#610): they are never evicted or
 * reloaded, so the only remedy is the user's, and the tooltip names it. Not a
 * button and not an alarm — the Doors themselves are the way back to each.
 */
export function RetainedPagesIndicator({ count }: { count: number }) {
  if (count <= RETAINED_PAGES_WARN_ABOVE) return null;
  const sentence = `${count} minimized web pages are still running. Minimized pages are never reloaded, `
    + 'so each keeps its memory and scripts; close the ones you no longer need.';
  return (
    <span
      role="status"
      aria-label={sentence}
      title={sentence}
      data-retained-pages={count}
      className="flex shrink-0 items-center gap-1 pb-1 text-sm font-mono text-muted"
    >
      <GaugeIcon size={14} weight="bold" aria-hidden />
      {count}
    </span>
  );
}
