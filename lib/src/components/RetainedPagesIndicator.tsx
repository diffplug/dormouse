import { GaugeIcon } from '@phosphor-icons/react';
import { retainedPagesWarning } from '../lib/surface-sight';

/**
 * A quiet count in the Baseboard's right cluster once more minimized pages
 * stay live than `RETAINED_PAGES_WARN_ABOVE` (#610): they are never evicted or
 * reloaded, so the only remedy is the user's, and the tooltip names it. Not a
 * button and not an alarm — the Doors themselves are the way back to each.
 */
export function RetainedPagesIndicator({ count }: { count: number }) {
  if (!retainedPagesWarning(count)) return null;
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
