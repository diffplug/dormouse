import { popReopenRecord, pushReopenRecord } from '../../lib/reopen-stack';
import { getActiveWorkspaceId, setActiveWorkspace } from '../../lib/workspace-store';
import type { WorkspaceId } from '../../lib/session-types';
import { getWallHandle } from './wall-handles';
import { isWindowControlMethod, unsupportedControlMethodMessage } from 'dor/protocol';
import type { ReopenResponse } from 'dor/commands/types';
import type { DorControlRequest } from './use-dor-control';

/**
 * The Reopen verb (`docs/specs/reopen.md`): `⌘⇧T`, command-mode `u`, and
 * `dor reopen` all land here, taking the newest record this Window holds.
 */

export type ReopenOutcome =
  | { kind: 'surface'; workspaceId: WorkspaceId; surfaceId: string; surfaceRef: string }
  | { kind: 'nothing' };

export const NOTHING_TO_REOPEN = 'Nothing to reopen';

/**
 * Reopen the newest record. A gesture brings what it reopened into view and
 * answers an empty stack with a brief notice; `dor reopen` stays
 * focus-neutral and reads the outcome instead.
 */
export function reopenClosed({ gesture }: { gesture: boolean }): ReopenOutcome {
  const record = popReopenRecord();
  if (!record) {
    if (gesture) getWallHandle(getActiveWorkspaceId())?.showNotice(NOTHING_TO_REOPEN);
    return { kind: 'nothing' };
  }
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

/** `dor reopen` (`window.reopen`): focus-neutral, and an empty stack refuses. */
export function handleReopenControl(detail: DorControlRequest): void {
  if (!isWindowControlMethod(detail.method)) {
    detail.respond({ ok: false, error: unsupportedControlMethodMessage(detail.method) });
    return;
  }
  const outcome = reopenClosed({ gesture: false });
  if (outcome.kind === 'nothing') {
    detail.respond({ ok: false, error: NOTHING_TO_REOPEN });
    return;
  }
  detail.respond({
    ok: true,
    result: { status: 'reopened', kind: 'surface', surfaceId: outcome.surfaceId, surfaceRef: outcome.surfaceRef } satisfies ReopenResponse,
  });
}
