import type { ReopenResponse } from 'dor/commands/types';
import { surfaceRefForId } from 'dor/protocol';
import { getPlatform } from '../../lib/platform';
import { newestReopenClosedAt, popReopenRecord, pushReopenRecord, type SurfaceReopenRecord, type WorkspaceReopenRecord } from '../../lib/reopen-stack';
import { withFreshSurfaceIds } from '../../lib/session-remap';
import { getPendingKills, pendingKillKey, restorePendingKill, type PendingKill } from '../../lib/pending-kills';
import { restoreSession } from '../../lib/session-restore';
import { createWorkspace, generateWorkspaceId, getActiveWorkspaceId, moveWorkspace, setActiveWorkspace, workspaceRefFor } from '../../lib/workspace-store';
import type { DorControlRequest } from './use-dor-control';
import { wallBootFromResult } from './wall-types';
import { getWallHandle } from './wall-handles';
import { mountingRefusal } from './dor-control-shared';
import { setWorkspaceBootPlan } from './workspace-boot-plans';

/**
 * The Reopen verb (`docs/specs/reopen.md`): `⌘⇧T`, command-mode `u`, and
 * `dor reopen` all land here, taking the newest record this Window holds.
 */

export const NOTHING_TO_REOPEN = 'Nothing to reopen';

/**
 * Reopen the newest record: this Window's own, or a closed window the host
 * holds, whichever closed last; null when there is nothing. A gesture brings
 * what it reopened into view and answers an empty stack with a brief notice;
 * `dor reopen` stays focus-neutral and reads the answer instead.
 */
export async function reopenClosed({ gesture }: { gesture: boolean }): Promise<ReopenResponse | null> {
  const recordAt = newestReopenClosedAt() ?? 0;
  const pending = getPendingKills()[0];
  // A host that cannot answer leaves this Window's own records to answer.
  const reopenedWindow = await getPlatform().reopenClosedWindow?.(Math.max(recordAt, pending?.startedAt ?? 0)).catch((error: unknown) => {
    console.warn('[reopen] the host could not reopen a closed window', error);
    return false;
  });
  if (reopenedWindow) return { status: 'reopened', kind: 'window' };
  // A pending kill newer than every record comes back as itself, not rebuilt;
  // one that cannot come back now gives way to the next.
  for (const kill of getPendingKills()) {
    if (kill.startedAt < recordAt) break;
    if (restorePendingKill(pendingKillKey(kill.kind, kill.id), gesture)) return restoredResponse(kill);
  }
  const record = popReopenRecord();
  if (!record) {
    if (gesture) getWallHandle(getActiveWorkspaceId())?.showNotice(NOTHING_TO_REOPEN);
    return null;
  }
  return record.kind === 'workspace' ? reopenWorkspace(record, gesture) : reopenSurface(record, gesture);
}

function reopenSurface(record: SurfaceReopenRecord, gesture: boolean): ReopenResponse | null {
  // A Surface whose Workspace has closed reopens in the active one.
  const handle = getWallHandle(record.workspaceId) ?? getWallHandle(getActiveWorkspaceId());
  if (!handle) {
    // Nothing mounted to take it: keep the record for the next attempt, and
    // say why rather than that there is nothing to reopen.
    pushReopenRecord(record);
    if (gesture) return null;
    throw new Error(mountingRefusal(workspaceRefFor(getActiveWorkspaceId())));
  }
  if (gesture) setActiveWorkspace(handle.workspaceId);
  const { id, ref } = handle.reopenSurface(record, gesture);
  return { status: 'reopened', kind: 'surface', surfaceId: id, surfaceRef: ref };
}

/**
 * A closed Workspace comes back as a new one, at its strip slot, through cold
 * restore: new Sessions and Surface ids, refs starting over.
 */
function reopenWorkspace(record: WorkspaceReopenRecord, gesture: boolean): ReopenResponse {
  const { name, nameIsAuto, session } = record.workspace;
  const id = generateWorkspaceId();
  const restored = restoreSession(getPlatform(), { savedSession: withFreshSurfaceIds(session) });
  // Parked before the Workspace exists: its Wall mounts from this plan.
  setWorkspaceBootPlan(id, restored ? wallBootFromResult(restored) : {});
  createWorkspace({ id, name, nameIsAuto, activate: gesture, alertDelivery: session.alertDelivery });
  moveWorkspace(id, record.index);
  return { status: 'reopened', kind: 'workspace', workspaceId: id, workspaceRef: workspaceRefFor(id) };
}

function restoredResponse(kill: PendingKill): ReopenResponse {
  if (kill.kind === 'workspace') {
    return { status: 'reopened', kind: 'workspace', workspaceId: kill.id, workspaceRef: workspaceRefFor(kill.id) };
  }
  // A helper comes back on its parent, the Surface a caller can name.
  const surfaceId = kill.surfaceId ?? kill.id;
  return { status: 'reopened', kind: 'surface', surfaceId, surfaceRef: surfaceRefForId(surfaceId) };
}

/** `dor reopen` (`window.reopen`): focus-neutral, and an empty stack refuses. */
export async function handleReopenControl(detail: DorControlRequest): Promise<void> {
  const result = await reopenClosed({ gesture: false });
  detail.respond(result ? { ok: true, result } : { ok: false, error: NOTHING_TO_REOPEN });
}
