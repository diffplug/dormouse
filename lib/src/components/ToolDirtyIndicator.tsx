import { useSyncExternalStore } from 'react';
import { getToolDirty, subscribeToToolDirty } from '../lib/tool-dirty-store';

export function useToolDirty(surfaceId: string): boolean | null {
  return useSyncExternalStore(subscribeToToolDirty, () => getToolDirty(surfaceId));
}

/** A Tool's last reported unsaved changes, independent of Activity alarms. */
export function ToolDirtyIndicator({ dirty }: { dirty: boolean | null }) {
  return dirty === true ? (
    <span role="img" aria-label="Unsaved changes" title="Unsaved changes"
      className="size-1.5 shrink-0 rounded-full bg-current" />
  ) : null;
}
