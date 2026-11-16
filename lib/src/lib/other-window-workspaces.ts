import type { WorkspaceId } from './session-types';

/** Another Window's Workspaces in strip order, as the host's registry holds them. */
export interface OtherWindowWorkspaces {
  /** The host's window label, `dor`'s `window:<label>`. */
  window: string;
  workspaces: readonly { id: WorkspaceId; name: string }[];
}

let snapshot: readonly OtherWindowWorkspaces[] = [];
const listeners = new Set<() => void>();

/** Every other Window's Workspaces; empty on a host with one Window. */
export function getOtherWindowWorkspaces(): readonly OtherWindowWorkspaces[] {
  return snapshot;
}

export function subscribeToOtherWindowWorkspaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The host's answer replaces the whole list. */
export function setOtherWindowWorkspaces(next: readonly OtherWindowWorkspaces[]): void {
  snapshot = next;
  for (const listener of listeners) listener();
}
