import { isWindowControlMethod, unsupportedControlMethodMessage } from 'dor/protocol';
import type { ReopenResponse } from 'dor/commands/types';
import { getPlatform } from '../../lib/platform';
import { newestReopenClosedAt, popReopenRecord, pushReopenRecord, type SurfaceReopenRecord, type WorkspaceReopenRecord } from '../../lib/reopen-stack';
import { withFreshSurfaceIds } from '../../lib/session-remap';
import { restoreSession } from '../../lib/session-restore';
import type { WorkspaceId } from '../../lib/session-types';
import { createWorkspace, generateWorkspaceId, getActiveWorkspaceId, moveWorkspace, setActiveWorkspace, workspaceRefFor } from '../../lib/workspace-store';
import type { DorControlRequest } from './use-dor-control';
import { wallBootFromResult } from './wall-types';
import { getWallHandle } from './wall-handles';
import { setWorkspaceBootPlan } from './workspace-boot-plans';
import { mintSurfaceId } from './window-reopen';

/**
 * The Reopen verb (`docs/specs/reopen.md`): `⌘⇧T`, command-mode `u`, and
 * `dor reopen` all land here, taking the newest record this Window holds.
 */

export type ReopenOutcome =
  | { kind: 'surface'; workspaceId: WorkspaceId; surfaceId: string; surfaceRef: string }
  | { kind: 'workspace'; workspaceId: WorkspaceId }
  | { kind: 'window' }
  | { kind: 'nothing' };

export const NOTHING_TO_REOPEN = 'Nothing to reopen';

/**
 * Reopen the newest record: this Window's own, or a closed window the host
 * holds, whichever closed last. A gesture brings what it reopened into view
 * and answers an empty stack with a brief notice; `dor reopen` stays
 * focus-neutral and reads the outcome instead.
 */
export async function reopenClosed({ gesture }: { gesture: boolean }): Promise<ReopenOutcome> {
  const platform = getPlatform();
  if (await platform.reopenClosedWindow?.(newestReopenClosedAt() ?? 0)) return { kind: 'window' };
  const record = popReopenRecord();
  if (!record) {
    if (gesture) getWallHandle(getActiveWorkspaceId())?.showNotice(NOTHING_TO_REOPEN);
    return { kind: 'nothing' };
  }
  return record.kind === 'workspace' ? reopenWorkspace(record, gesture) : reopenSurface(record, gesture);
}

function reopenSurface(record: SurfaceReopenRecord, gesture: boolean): ReopenOutcome {
  // A Surface whose Workspace has closed reopens in the active one.
  const handle = getWallHandle(record.workspaceId) ?? getWallHandle(getActiveWorkspaceId());
  if (!handle) {
    // Nothing mounted to take it: keep the record for the next attempt.
    pushReopenRecord(record);
    return { kind: 'nothing' };
  }
  if (gesture) setActiveWorkspace(handle.workspaceId);
  const { id, ref } = handle.reopenSurface(record, gesture);
  return { kind: 'surface', workspaceId: handle.workspaceId, surfaceId: id, surfaceRef: ref };
}

/**
 * A closed Workspace comes back as a new one, at its strip slot, through cold
 * restore: new Sessions and Surface ids, refs starting over.
 */
function reopenWorkspace(record: WorkspaceReopenRecord, gesture: boolean): ReopenOutcome {
  const { name, nameIsAuto, session } = record.workspace;
  const id = generateWorkspaceId();
  const restored = restoreSession(getPlatform(), { savedSession: withFreshSurfaceIds(session, mintSurfaceId) });
  // Parked before the Workspace exists: its Wall mounts from this plan.
  setWorkspaceBootPlan(id, restored ? wallBootFromResult(restored) : {});
  createWorkspace({ id, name, nameIsAuto, activate: gesture, alertDelivery: session.alertDelivery });
  moveWorkspace(id, record.index);
  return { kind: 'workspace', workspaceId: id };
}

/** `dor reopen` (`window.reopen`): focus-neutral, and an empty stack refuses. */
export async function handleReopenControl(detail: DorControlRequest): Promise<void> {
  if (!isWindowControlMethod(detail.method)) {
    detail.respond({ ok: false, error: unsupportedControlMethodMessage(detail.method) });
    return;
  }
  const outcome = await reopenClosed({ gesture: false });
  if (outcome.kind === 'nothing') {
    detail.respond({ ok: false, error: NOTHING_TO_REOPEN });
    return;
  }
  const result: ReopenResponse = outcome.kind === 'surface'
    ? { status: 'reopened', kind: 'surface', surfaceId: outcome.surfaceId, surfaceRef: outcome.surfaceRef }
    : outcome.kind === 'workspace'
      ? { status: 'reopened', kind: 'workspace', workspaceId: outcome.workspaceId, workspaceRef: workspaceRefFor(outcome.workspaceId) }
      : { status: 'reopened', kind: 'window' };
  detail.respond({ ok: true, result });
}
