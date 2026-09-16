import { useContext, useMemo, useSyncExternalStore } from 'react';
import { WorkspaceIdContext } from './wall-context';
import { getWorkspace, subscribeToWorkspaces } from '../../lib/workspace-store';
import { getAlertSettings, subscribeToAlertSettings, type AlertSettings } from '../../lib/alert-settings';
import { resolveAlertDeliveryPolicy, type AlertDeliveryOverrides, type AlertDeliveryPolicy } from '../../lib/alert-delivery-model';

/**
 * The effective alarm policy where this component renders: application
 * defaults under the enclosing Workspace's sparse overrides
 * (`docs/specs/alert.md` → Alarm settings). `overrides` is the store's own
 * object, so unrelated Workspace edits do not re-render the caller; outside a
 * Wall, or with `scoped` false, it is undefined and the policy is the defaults.
 */
export function useWorkspaceAlertPolicy(scoped = true): {
  workspaceId: string | null;
  defaults: AlertSettings;
  overrides: AlertDeliveryOverrides | undefined;
  policy: AlertDeliveryPolicy;
} {
  const workspaceId = useContext(WorkspaceIdContext);
  const defaults = useSyncExternalStore(subscribeToAlertSettings, getAlertSettings);
  const overrides = useSyncExternalStore(subscribeToWorkspaces, () => (scoped && workspaceId ? getWorkspace(workspaceId)?.alertDelivery : undefined));
  const policy = useMemo(() => resolveAlertDeliveryPolicy(defaults, overrides), [defaults, overrides]);
  return { workspaceId, defaults, overrides, policy };
}
