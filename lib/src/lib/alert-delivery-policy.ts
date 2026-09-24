import { resolveAlertDeliveryPolicy, type AlertDeliveryPolicy, type AlertDeliveryOverrides } from './alert-delivery-model';
import { getAlertSettings, subscribeToAlertSettings } from './alert-settings';
import { getWorkspace, subscribeToWorkspaces } from './workspace-store';
import { getWorkspaceSurfacesSnapshot, subscribeToWorkspaceSurfaces } from './workspace-surfaces';

function sessionWorkspaceId(sessionId: string): string | null {
  for (const [workspaceId, ids] of getWorkspaceSurfacesSnapshot()) {
    if (ids.includes(sessionId)) return workspaceId;
  }
  return null;
}

/** Application defaults under the sparse overrides of the Session's
 *  Workspace; a Session with none uses the defaults. */
export function getSessionAlertPolicy(sessionId: string): AlertDeliveryPolicy {
  const workspaceId = sessionWorkspaceId(sessionId);
  return resolveAlertDeliveryPolicy(getAlertSettings(), workspaceId === null ? undefined : getWorkspace(workspaceId)?.alertDelivery);
}

export function subscribeToAlertDeliveryPolicy(listener: () => void): () => void {
  const stops = [subscribeToAlertSettings(listener), subscribeToWorkspaces(listener), subscribeToWorkspaceSurfaces(listener)];
  return () => stops.forEach((stop) => stop());
}

/** Every member Surface of this realm's Workspaces, with its Workspace's
 *  sparse overrides: what the host's delivery scheduler is told. */
export function collectDeliveryOverrides(): Record<string, AlertDeliveryOverrides> {
  const overrides: Record<string, AlertDeliveryOverrides> = {};
  for (const [workspaceId, ids] of getWorkspaceSurfacesSnapshot()) {
    const workspace = getWorkspace(workspaceId)?.alertDelivery ?? {};
    for (const id of ids) overrides[id] = workspace;
  }
  return overrides;
}
