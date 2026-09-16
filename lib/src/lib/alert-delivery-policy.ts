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

const incoming = new Map<string, AlertDeliveryOverrides>();
/** Policy during the interval before the arriving Workspace mounts. */
export function setIncomingAlertPolicy(ids: readonly string[], overrides?: AlertDeliveryOverrides): void {
  for (const id of ids) {
    if (overrides) incoming.set(id, overrides);
    else incoming.delete(id);
  }
}

/** Application defaults under the sparse overrides of the Session's Workspace
 *  (staged, else current); a Session with neither uses the defaults. */
export function getSessionAlertPolicy(sessionId: string): AlertDeliveryPolicy {
  const workspaceId = sessionWorkspaceId(sessionId);
  const overrides = incoming.get(sessionId) ?? (workspaceId === null ? undefined : getWorkspace(workspaceId)?.alertDelivery);
  return resolveAlertDeliveryPolicy(getAlertSettings(), overrides);
}

export function subscribeToAlertDeliveryPolicy(listener: () => void): () => void {
  const stops = [subscribeToAlertSettings(listener), subscribeToWorkspaces(listener), subscribeToWorkspaceSurfaces(listener)];
  return () => stops.forEach((stop) => stop());
}
