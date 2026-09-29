import { useSyncExternalStore } from 'react';
import { clsx } from 'clsx';
import { getToolDirty, subscribeToToolDirty } from '../lib/tool-dirty-store';
import { isToolParams } from './wall/browser-surface';

const noSubscription = () => () => {};

/** Whether a Tool's last report says it has unsaved changes. A report from a
 *  plain terminal stays inert. */
export function isToolDirty(surfaceId: string, params: unknown): boolean {
  return isToolParams(params) && getToolDirty(surfaceId) === true;
}

/** `isToolDirty`, subscribed. Ordinary Surfaces never subscribe. */
export function useToolDirty(surfaceId: string, params: unknown): boolean {
  return useSyncExternalStore(isToolParams(params) ? subscribeToToolDirty : noSubscription, () => isToolDirty(surfaceId, params));
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
