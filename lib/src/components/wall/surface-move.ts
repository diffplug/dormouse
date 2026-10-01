import { flushSync } from 'react-dom';
import type { MoveSurfaceRequest, MoveSurfaceResponse } from 'dor/commands/types';
import { closeWorkspace, createWorkspace, generateWorkspaceId, getActiveWorkspaceId, hasWorkspace, resolveWorkspaceRef, setActiveWorkspace, workspaceRefFor } from '../../lib/workspace-store';
import { beginWorkspaceSessionBatch, forgetWorkspaceSession, invalidateWorkspaceSaves, isWorkspaceTransferPending, moveRetainedSurfaceRecord, previousWorkspaceSession, publishWorkspaceSession, setWorkspaceTransferPending } from '../../lib/window-session-aggregator';
import { getWorkspaceUiSnapshot, setPendingSurfaceMove, setWorkspaceMoveError } from '../../lib/workspace-ui-store';
import { getTerminalInstance } from '../../lib/terminal-registry';
import { randomKillChar } from '../KillConfirm';
import { awaitWallHandle, errorText } from './dor-control-shared';
import { forgetWorkspaceBootPlan, setWorkspaceBootPlan } from './workspace-boot-plans';
import { getWallHandle, wallHandleOwning, type WallHandle } from './wall-handles';

let moving = false;

function consent(source: string): Promise<boolean> {
  const ui = getWorkspaceUiSnapshot();
  if (ui.pendingClose || ui.pendingMove || ui.pendingSurfaceMove || ui.renamingId) throw new Error('Finish the open Workspace dialog before moving this Surface');
  return new Promise(resolve => setPendingSurfaceMove({ id: source, char: randomKillChar(), answer: accepted => {
    setPendingSurfaceMove(null);
    resolve(accepted);
  } }));
}

/** One coordinator for GUI and dor. Preparation and consent change no membership;
 * the synchronous departure/adoption is reversible until both records are built. */
export async function moveSurface(id: string, request: Omit<MoveSurfaceRequest, 'surface' | 'workspace'>, gui = false): Promise<MoveSurfaceResponse | null> {
  if (moving) throw new Error('Another Surface move is in progress');
  const source = wallHandleOwning(id);
  if (!source?.canMoveSurfaces) throw new Error('This host does not support moving Surfaces between Workspaces');
  const destination = request.destination;
  const resolved = 'workspace' in destination ? resolveWorkspaceRef(destination.workspace) : null;
  if (resolved && !resolved.ok) throw new Error(resolved.message);
  let targetId = resolved?.ok ? resolved.id : null;
  const result = (ref: string): MoveSurfaceResponse => ({ status: 'moved', surfaceId: id, surfaceRef: ref, workspaceId: targetId!, workspaceRef: workspaceRefFor(targetId!) });
  if (targetId === source.workspaceId) throw new Error('The Surface is already in that Workspace');
  if (!targetId && source.surfaceIds().length <= 1) throw new Error('The only Surface is already in its own Workspace');
  if (isWorkspaceTransferPending(source.workspaceId) || (targetId && isWorkspaceTransferPending(targetId))) throw new Error('A Workspace is already moving');
  let target: WallHandle | null = targetId ? getWallHandle(targetId) : null;
  if (targetId && !target?.canMoveSurfaces) throw new Error('The destination Workspace is unavailable');
  let prepared = source.prepareSurfaceMove(id);
  if (prepared.iframe && !request.dangerouslyDestroyIframePageState && !gui) throw new Error('Moving this iframe reopens at its saved URL; pass --dangerously-destroy-iframe-page-state to accept losing page state');
  moving = true;
  setWorkspaceTransferPending(source.workspaceId, true);
  if (targetId) setWorkspaceTransferPending(targetId, true);
  const activeBefore = getActiveWorkspaceId();
  const oldWorkspaceRef = workspaceRefFor(source.workspaceId);
  let iframeConsented = request.dangerouslyDestroyIframePageState;
  let created = false;
  let committed = false;
  let endBatch: (() => void) | undefined;
  let undoDeparture: (() => void) | undefined;
  let undoAdoption: (() => void) | undefined;
  let sourceRecord = previousWorkspaceSession(source.workspaceId);
  let targetRecord = targetId ? previousWorkspaceSession(targetId) : null;
  try {
    if (prepared.iframe && !iframeConsented) {
      if (!await consent(source.workspaceId)) return null;
      iframeConsented = true;
    }
    // Neither a dialog nor a cwd probe reserves the Surface's kind or dirty state.
    await source.flushPersistence({ probeCwd: false });
    if (target) await target.flushPersistence({ probeCwd: false });
    sourceRecord = previousWorkspaceSession(source.workspaceId);
    if (targetId) targetRecord = previousWorkspaceSession(targetId);
    if (!hasWorkspace(source.workspaceId) || !source.ownsSurface(id)) throw new Error('The source Surface is no longer available');
    if (targetId && (!hasWorkspace(targetId) || getWallHandle(targetId) !== target)) throw new Error('The destination Workspace is no longer available');
    if (!targetId && source.surfaceIds().length <= 1) throw new Error('The only Surface is already in its own Workspace');
    prepared = source.prepareSurfaceMove(id);
    // A Tool may start serving an iframe while the persistence flush awaits.
    if (prepared.iframe && !iframeConsented) {
      if (!gui) throw new Error('Pass --dangerously-destroy-iframe-page-state to move this iframe');
      if (!await consent(source.workspaceId)) return null;
      iframeConsented = true;
      prepared = source.prepareSurfaceMove(id);
    }
    endBatch = beginWorkspaceSessionBatch();
    invalidateWorkspaceSaves(source.workspaceId);
    if (!targetId) {
      targetId = generateWorkspaceId();
      setWorkspaceBootPlan(targetId, { emptyForMove: true });
      flushSync(() => createWorkspace({ id: targetId!, activate: false }));
      created = true;
      setWorkspaceTransferPending(targetId, true);
      target = getWallHandle(targetId) ?? await awaitWallHandle(targetId);
      if (!target) throw new Error('The new Workspace did not mount');
    }
    targetRecord = previousWorkspaceSession(targetId);
    invalidateWorkspaceSaves(targetId);
    // Revalidate after the new Wall's passive registration too.
    prepared = source.prepareSurfaceMove(id);
    if (prepared.iframe && !iframeConsented) throw new Error('This Surface started serving an iframe; retry the move to confirm its refresh');
    let surfaceRef = '';
    flushSync(() => {
      undoDeparture = prepared.depart();
      try {
        const adopted = target!.adoptSurfaceMove(id, prepared.meta);
        undoAdoption = adopted.rollback;
        surfaceRef = adopted.surfaceRef;
      } catch (error) { undoDeparture(); undoDeparture = undefined; throw error; }
      target!.finishSurfaceMove();
      source.finishSurfaceMove();
    });
    // Mounting a new Wall can let saves collect the pre-departure layout. Fence
    // those too, once both ownership changes have completed synchronously.
    invalidateWorkspaceSaves(source.workspaceId);
    invalidateWorkspaceSaves(targetId);
    moveRetainedSurfaceRecord(id, source.workspaceId, targetId);
    const [sourceSession, targetSession] = await Promise.all([
      source.serializePersistence({ probeCwd: false }), target!.serializePersistence({ probeCwd: false }),
    ]);
    publishWorkspaceSession(source.workspaceId, sourceSession);
    publishWorkspaceSession(targetId, targetSession);
    // Closing the source is irreversible. Later UI/notice failures must never
    // restore membership into a Wall that has already unmounted.
    committed = true;
    undoDeparture = undefined; undoAdoption = undefined;
    const sourceEmpty = source.surfaceIds().length === 0;
    flushSync(() => {
      if (sourceEmpty) { closeWorkspace(source.workspaceId); forgetWorkspaceSession(source.workspaceId); forgetWorkspaceBootPlan(source.workspaceId); }
      if (gui || request.focus) {
        setActiveWorkspace(targetId!);
        target!.focusSurface(id, gui);
      } else if (sourceEmpty && activeBefore === source.workspaceId) {
        setActiveWorkspace(targetId!); target!.enterCommandMode();
      }
    });
    const response = result(surfaceRef);
    if (prepared.terminal) {
      const safe = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
      const terminal = getTerminalInstance(id);
      if (terminal?.buffer.active.type === 'alternate') {
        target!.showMoveNotice(id, `Moved ${prepared.surfaceRef} from ${oldWorkspaceRef} to ${response.workspaceRef} ${response.surfaceRef}. Cached surface:N refs now resolve here; use stable ID ${id}. Unscoped dor ensure can duplicate work left behind.`);
      } else terminal?.write(`\r\n[Dormouse] Moved ${safe(prepared.surfaceRef)} from ${oldWorkspaceRef} to ${response.workspaceRef} ${response.surfaceRef}. Stable ID: ${safe(id)}.\r\nShort surface:N refs now resolve in the destination Workspace; cached refs may target other panes. Unscoped dor ensure searches here and can duplicate a server left behind. Use stable IDs across moves.\r\n`);
    }
    undoDeparture = undefined; undoAdoption = undefined;
    return response;
  } catch (error) {
    if (committed) throw error;
    invalidateWorkspaceSaves(source.workspaceId);
    if (targetId) invalidateWorkspaceSaves(targetId);
    flushSync(() => {
      undoAdoption?.(); undoDeparture?.();
      source.finishSurfaceMove(); target?.finishSurfaceMove();
      if (created && targetId) { closeWorkspace(targetId); forgetWorkspaceSession(targetId); forgetWorkspaceBootPlan(targetId); }
      if (hasWorkspace(activeBefore)) setActiveWorkspace(activeBefore);
    });
    if (sourceRecord) publishWorkspaceSession(source.workspaceId, sourceRecord);
    if (!created && targetId && targetRecord) publishWorkspaceSession(targetId, targetRecord);
    throw error;
  } finally {
    endBatch?.();
    setWorkspaceTransferPending(source.workspaceId, false);
    if (targetId) setWorkspaceTransferPending(targetId, false);
    moving = false;
  }
}

/** Gesture errors use the Window's existing move refusal presentation. */
export function requestSurfaceMove(id: string, destination: MoveSurfaceRequest['destination']): void {
  const source = wallHandleOwning(id);
  const target = 'workspace' in destination && hasWorkspace(destination.workspace) ? { workspace: workspaceRefFor(destination.workspace) } : destination;
  void moveSurface(id, { destination: target, focus: true, dangerouslyDestroyIframePageState: false }, true).catch(error => {
    if (source) setWorkspaceMoveError({ id: source.workspaceId, reason: errorText(error) });
  });
}
