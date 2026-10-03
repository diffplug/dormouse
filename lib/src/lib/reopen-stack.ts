import type { LeafMeta } from './lath/persistence';
import type { RestoreToken } from './lath/ops';
import type { PersistedPane, PersistedWorkspace, WorkspaceId } from './session-types';

/**
 * What a close leaves for Reopen (`docs/specs/reopen.md`): one record per
 * reopenable close, newest first, in this Window's memory only. Never
 * persisted — cold restore already covers a quit.
 */

/** A closed Surface, rebuilt as a new Session through the cold-restore path. */
export interface SurfaceReopenRecord {
  kind: 'surface';
  closedAt: number;
  workspaceId: WorkspaceId;
  /** The `PersistedPane` projection: cwd, title, command, Tool metadata. */
  pane: PersistedPane;
  /** `persistableLeafMeta` of the leaf. */
  meta: LeafMeta;
  /** Where it sat: a Pane's restore token, or a Door's slot on the Baseboard. */
  placement: { kind: 'pane'; token: RestoreToken } | { kind: 'door'; index: number; token: unknown };
}

/** A closed Workspace: its record as a save would publish it, and its slot. */
export interface WorkspaceReopenRecord {
  kind: 'workspace';
  closedAt: number;
  workspace: PersistedWorkspace;
  /** Its strip position at the close. */
  index: number;
}

export type ReopenRecord = SurfaceReopenRecord | WorkspaceReopenRecord;

const CAPACITY = 20;
const records: ReopenRecord[] = [];

/** Push a close's record, or put back one whose reopen could not run. */
export function pushReopenRecord(record: ReopenRecord): void {
  records.unshift(record);
  records.length = Math.min(records.length, CAPACITY);
}

/** Take the newest record, or undefined when the stack is empty. */
export function popReopenRecord(): ReopenRecord | undefined {
  return records.shift();
}

/** When the newest record closed, or null with nothing to reopen. */
export function newestReopenClosedAt(): number | null {
  return records[0]?.closedAt ?? null;
}

/** @internal */
export function _resetReopenStackForTesting(): void {
  records.length = 0;
}

/** @internal */
export function _reopenRecordsForTesting(): readonly ReopenRecord[] {
  return records;
}
