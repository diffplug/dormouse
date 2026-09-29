import { useSyncExternalStore } from 'react';
import { clsx } from 'clsx';
import { getToolDirty, subscribeToToolDirty } from '../lib/tool-dirty-store';
import { isToolParams } from './wall/browser-surface';

const noSubscription = () => () => {};

/** Whether a Tool's last report says it has unsaved changes. Ordinary Surfaces
 *  never subscribe: a report from a plain terminal stays inert. */
export function useToolDirty(surfaceId: string, params: unknown): boolean {
  const tool = isToolParams(params);
  return useSyncExternalStore(tool ? subscribeToToolDirty : noSubscription, () => tool && getToolDirty(surfaceId) === true);
}

/** The name, tooltip, and description of a Tool's unsaved state, wherever it shows. */
export const TOOL_DIRTY_LABEL = 'Unsaved changes';

/** The unsaved-state dot in Tool chrome, independent of Activity alarms. */
export function ToolDirtyIndicator({ dirty, className }: { dirty: boolean; className?: string }) {
  return dirty ? (
    <span role="img" aria-label={TOOL_DIRTY_LABEL} title={TOOL_DIRTY_LABEL}
      className={clsx('size-1.5 shrink-0 rounded-full bg-current', className)} />
  ) : null;
}
