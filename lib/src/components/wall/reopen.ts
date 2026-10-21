import { isWorkspaceTransferPending } from '../../lib/window-session-aggregator';
import type { ReopenResponse } from 'dor/commands/types';
import { getPlatform } from '../../lib/platform';
import { newestReopenClosedAt, popReopenRecord, pushReopenRecord, type SurfaceReopenRecord, type WorkspaceReopenRecord } from '../../lib/reopen-stack';
import { withFreshSurfaceIds } from '../../lib/session-remap';
import { getPendingKills, pendingKillKey, restorePendingKill, type PendingKill } from '../../lib/pending-kills';
import { restoreSession } from '../../lib/session-restore';
import { createWorkspace, generateWorkspaceId, getActiveWorkspaceId, moveWorkspace, setActiveWorkspace } from '../../lib/workspace-store';
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
  // Compare the host's windows with each candidate, including after a pending
  // helper refuses: skipping it must also lower the host's cutoff.
  for (const kill of getPendingKills()) {
    if (kill.startedAt < recordAt) break;
    if (await reopenWindowAfter(kill.startedAt)) return { status: 'reopened', kind: 'window' };
    if (restorePendingKill(pendingKillKey(kill.kind, kill.id), gesture)) return restoredResponse(kill);
  }
  if (await reopenWindowAfter(recordAt)) return { status: 'reopened', kind: 'window' };
  const record = popReopenRecord();
  if (!record) {
    if (gesture) getWallHandle(getActiveWorkspaceId())?.showNotice(NOTHING_TO_REOPEN);
    return null;
  }
  return record.kind === 'workspace' ? reopenWorkspace(record, gesture) : reopenSurface(record, gesture);
}

/** A host that cannot answer leaves this Window's own candidates to answer. */
async function reopenWindowAfter(closedAt: number): Promise<boolean> {
  return await getPlatform().reopenClosedWindow?.(closedAt).catch((error: unknown) => {
    console.warn('[reopen] the host could not reopen a closed window', error);
    return false;
  }) ?? false;
}

function reopenSurface(record: SurfaceReopenRecord, gesture: boolean): ReopenResponse | null {
  // A Surface whose Workspace has closed reopens in the active one.
  const handle = getWallHandle(record.workspaceId) ?? getWallHandle(getActiveWorkspaceId());
  if (!handle) {
    // Nothing mounted to take it: keep the record for the next attempt, and
    // say why rather than that there is nothing to reopen.
    pushReopenRecord(record);
    if (gesture) return null;
    throw new Error(mountingRefusal(getActiveWorkspaceId()));
  }
  if (isWorkspaceTransferPending(handle.workspaceId)) {
    pushReopenRecord(record);
    if (gesture) { handle.showNotice('Workspace is transferring'); return null; }
    throw new Error('Workspace is transferring');
  }
  if (gesture) setActiveWorkspace(handle.workspaceId);
  const id = handle.reopenSurface(record, gesture);
  return { status: 'reopened', kind: 'surface', surfaceId: id };
}

/**
 * A closed Workspace comes back as a new one, at its strip slot, through cold
 * restore: new Sessions and Surface ids.
 */
async function reopenWorkspace(record: WorkspaceReopenRecord, gesture: boolean): Promise<ReopenResponse> {
  const { name, nameIsAuto, session } = record.workspace;
  const [savedSession] = await withFreshSurfaceIds([session]);
  const id = generateWorkspaceId();
  const restored = restoreSession(getPlatform(), { savedSession });
  // Parked before the Workspace exists: its Wall mounts from this plan.
  setWorkspaceBootPlan(id, restored ? wallBootFromResult(restored) : {});
  createWorkspace({ id, name, nameIsAuto, activate: gesture, alertDelivery: session.alertDelivery });
  moveWorkspace(id, record.index);
  return { status: 'reopened', kind: 'workspace', workspaceId: id };
}

function restoredResponse(kill: PendingKill): ReopenResponse {
  if (kill.kind === 'workspace') {
    return { status: 'reopened', kind: 'workspace', workspaceId: kill.id };
  }
  // A helper comes back on its parent, the Surface a caller can name.
  const surfaceId = kill.surfaceId ?? kill.id;
  return { status: 'reopened', kind: 'surface', surfaceId };
}

/** `dor reopen` (`window.reopen`): focus-neutral, and an empty stack refuses. */
export async function handleReopenControl(detail: DorControlRequest): Promise<void> {
  const result = await reopenClosed({ gesture: false });
  detail.respond(result ? { ok: true, result } : { ok: false, error: NOTHING_TO_REOPEN });
}
