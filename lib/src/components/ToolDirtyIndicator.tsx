import { useSyncExternalStore } from 'react';
import { getToolDirty, subscribeToToolDirty } from '../lib/tool-dirty-store';
import { isToolParams } from './wall/browser-surface';

const noSubscription = () => () => {};

/** Whether a Tool's last report says it has unsaved changes. Ordinary Surfaces
 *  never subscribe: a report from a plain terminal stays inert. */
export function useToolDirty(surfaceId: string, params: unknown): boolean {
  const tool = isToolParams(params);
  return useSyncExternalStore(tool ? subscribeToToolDirty : noSubscription, () => tool && getToolDirty(surfaceId) === true);
}

/** The dot beside a Tool's title, independent of Activity alarms. */
export function ToolDirtyIndicator({ dirty }: { dirty: boolean }) {
  return dirty ? (
    <span role="img" aria-label="Unsaved changes" title="Unsaved changes"
      className="size-1.5 shrink-0 rounded-full bg-current" />
  ) : null;
}
