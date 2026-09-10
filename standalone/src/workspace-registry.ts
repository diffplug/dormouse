/**
 * This Window's half of the application-wide Workspace registry
 * (docs/specs/standalone.md → "Workspace registry"): ids are minted from a
 * block the host reserved, every store change is reported to the host, and the
 * host's union of every window comes back as a snapshot the strip and `dor`
 * can read.
 */
import { useSyncExternalStore } from "react";
import {
  getWorkspacesSnapshot,
  installWorkspaceIdPool,
  subscribeToWorkspaces,
} from "dormouse-lib/lib/workspace-store";

export interface RegistryWorkspace {
  id: string;
  /** `workspace:<n>` for a minted id; `null` for one the registry did not mint. */
  ref: string | null;
  name: string;
  active: boolean;
}

export interface RegistryWindow {
  label: string;
  workspaces: RegistryWorkspace[];
}

export interface WorkspaceRegistrySnapshot {
  revision: number;
  windows: RegistryWindow[];
}

const EMPTY: WorkspaceRegistrySnapshot = { revision: 0, windows: [] };
let snapshot: WorkspaceRegistrySnapshot = EMPTY;
const listeners = new Set<() => void>();

/** Accept a host snapshot, unless one newer is already held. */
export function acceptRegistrySnapshot(next: WorkspaceRegistrySnapshot): void {
  if (next.revision < snapshot.revision) return;
  snapshot = next;
  listeners.forEach((listener) => listener());
}

export function getRegistrySnapshot(): WorkspaceRegistrySnapshot {
  return snapshot;
}

export function useWorkspaceRegistry(): WorkspaceRegistrySnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getRegistrySnapshot,
  );
}

export function resetWorkspaceRegistry(): void {
  snapshot = EMPTY;
  listeners.forEach((listener) => listener());
}

export interface RegistryHost {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  /** Subscribe to the host's registry broadcasts; returns the unsubscribe. */
  onSnapshot(handler: (snapshot: WorkspaceRegistrySnapshot) => void): Promise<() => void> | (() => void);
}

/**
 * Install this Window into the registry. Resolves once the first id block is
 * in hand, so a Workspace created after boot never carries an unminted id.
 * Reports coalesce per microtask: a restore that sets several Workspaces at
 * once is one report, not one per entry.
 */
export async function installWorkspaceRegistry(host: RegistryHost): Promise<() => void> {
  let scheduled = false;
  let last = "";
  const report = () => {
    scheduled = false;
    const { workspaces, activeId } = getWorkspacesSnapshot();
    const entries = workspaces.map((ws) => ({ id: ws.id, name: ws.name, active: ws.id === activeId }));
    const key = JSON.stringify(entries);
    if (key === last) return;
    last = key;
    void host.invoke("workspace_report", { entries }).catch(() => {});
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(report);
  };
  const unsubscribeStore = subscribeToWorkspaces(schedule);
  const unlisten = await host.onSnapshot(acceptRegistrySnapshot);
  await installWorkspaceIdPool((count) => host.invoke<string[]>("workspace_reserve_ids", { count }));
  try {
    acceptRegistrySnapshot(await host.invoke<WorkspaceRegistrySnapshot>("workspace_registry"));
  } catch {
    // A host without the registry (an older dev harness) leaves it empty.
  }
  schedule();
  return () => {
    unsubscribeStore();
    unlisten();
  };
}
