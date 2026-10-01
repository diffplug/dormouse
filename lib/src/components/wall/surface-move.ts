import { flushSync } from 'react-dom';
import type { MoveSurfaceRequest, MoveSurfaceResponse } from 'dor/commands/types';
import { closeWorkspace, createWorkspace, generateWorkspaceId, getActiveWorkspaceId, hasWorkspace, resolveWorkspaceRef, setActiveWorkspace, workspaceRefFor } from '../../lib/workspace-store';
import { beginWorkspaceSessionBatch, forgetWorkspaceSession, invalidateWorkspaceSaves, isWorkspaceTransferPending, moveRetainedSurfaceRecord, previousWorkspaceSession, publishWorkspaceSession, setWorkspaceTransferPending } from '../../lib/window-session-aggregator';
import { dismissWorkspaceUi, getWorkspaceUiSnapshot, setPendingSurfaceMove, setWorkspaceMoveError } from '../../lib/workspace-ui-store';
import type { PersistedSession, WorkspaceId } from '../../lib/session-types';
import { sanitizeText } from '../../lib/osc-sanitize';
import { getTerminalInstance } from '../../lib/terminal-registry';
import { randomKillChar } from '../KillConfirm';
import { awaitWallHandle, errorText } from './dor-control-shared';
import { forgetWorkspaceBootPlan, setWorkspaceBootPlan } from './workspace-boot-plans';
import { getWallHandle, wallHandleOwning, type WallHandle } from './wall-handles';

let moving = false;

const IFRAME_FLAG_REQUIRED = 'Moving this iframe reopens at its saved URL; pass --dangerously-destroy-iframe-page-state to accept losing page state';

function consent(source: string): Promise<boolean> {
  const ui = getWorkspaceUiSnapshot();
  if (ui.pendingClose || ui.pendingMove || ui.pendingSurfaceMove || ui.renamingId) throw new Error('Finish the open Workspace dialog before moving this Surface');
  return new Promise(resolve => setPendingSurfaceMove({ id: source, char: randomKillChar(), answer: accepted => {
    setPendingSurfaceMove(null);
    resolve(accepted);
  } }));
}

/** The same close tail as `closeWorkspaceWithSurfaces`, for a Wall left empty. */
function discardWorkspace(id: WorkspaceId): void {
  closeWorkspace(id);
  forgetWorkspaceSession(id);
  forgetWorkspaceBootPlan(id);
  dismissWorkspaceUi(id);
}

/** One coordinator for GUI and dor. Preparation and consent change no membership;
 * the synchronous departure/adoption is reversible until both records are published. */
export async function moveSurface(id: string, request: Omit<MoveSurfaceRequest, 'surface' | 'workspace'>, gui = false): Promise<MoveSurfaceResponse | null> {
  if (moving) throw new Error('Another Surface move is in progress');
  const source = wallHandleOwning(id);
  if (!source?.canMoveSurfaces) throw new Error('This host does not support moving Surfaces between Workspaces');
  const destination = request.destination;
  const resolved = 'workspace' in destination ? resolveWorkspaceRef(destination.workspace) : null;
  if (resolved && !resolved.ok) throw new Error(resolved.message);
  let targetId = resolved?.ok ? resolved.id : null;
  if (targetId === source.workspaceId) throw new Error('The Surface is already in that Workspace');
  const toNew = !targetId;
  let target: WallHandle | null = targetId ? getWallHandle(targetId) : null;
  /** Rechecked after every await: either Wall may close or remount meanwhile. */
  const checkEndpoints = () => {
    if (!hasWorkspace(source.workspaceId) || getWallHandle(source.workspaceId) !== source) throw new Error('The source Surface is no longer available');
    if (toNew && source.surfaceIds().length <= 1) throw new Error('The only Surface is already in its own Workspace');
    if (targetId && (!hasWorkspace(targetId) || !target?.canMoveSurfaces || getWallHandle(targetId) !== target)) throw new Error('The destination Workspace is unavailable');
  };
  checkEndpoints();
  if (isWorkspaceTransferPending(source.workspaceId) || (targetId && isWorkspaceTransferPending(targetId))) throw new Error('A Workspace is already moving');
  let prepared = source.prepareSurfaceMove(id);
  let iframeConsented = request.dangerouslyDestroyIframePageState;
  if (prepared.iframe && !iframeConsented && !gui) throw new Error(IFRAME_FLAG_REQUIRED);
  /** False when the user cancels; a dor caller never sees a dialog. */
  const ensureIframeConsent = async (): Promise<boolean> => {
    if (!prepared.iframe || iframeConsented) return true;
    if (!gui) throw new Error(IFRAME_FLAG_REQUIRED);
    if (!await consent(source.workspaceId)) return false;
    iframeConsented = true;
    prepared = source.prepareSurfaceMove(id);
    return true;
  };
  moving = true;
  setWorkspaceTransferPending(source.workspaceId, true);
  if (targetId) setWorkspaceTransferPending(targetId, true);
  const activeBefore = getActiveWorkspaceId();
  const oldWorkspaceRef = workspaceRefFor(source.workspaceId);
  let created = false;
  let committed = false;
  let endBatch: (() => void) | undefined;
  let undoDeparture: (() => void) | undefined;
  let undoAdoption: (() => void) | undefined;
  let sourceRecord: PersistedSession | null = null;
  let targetRecord: PersistedSession | null = null;
  try {
    if (!await ensureIframeConsent()) return null;
    // Neither a dialog nor a cwd probe reserves the Surface's kind or dirty state.
    await Promise.all([source.flushPersistence({ probeCwd: false }), target?.flushPersistence({ probeCwd: false })]);
    checkEndpoints();
    prepared = source.prepareSurfaceMove(id);
    // A Tool may start serving an iframe while the persistence flush awaits.
    if (!await ensureIframeConsent()) return null;
    checkEndpoints();
    endBatch = beginWorkspaceSessionBatch();
    sourceRecord = previousWorkspaceSession(source.workspaceId);
    invalidateWorkspaceSaves(source.workspaceId);
    if (!targetId) {
      targetId = generateWorkspaceId();
      setWorkspaceBootPlan(targetId, { emptyForMove: true });
      flushSync(() => createWorkspace({ id: targetId!, activate: false }));
      created = true;
      setWorkspaceTransferPending(targetId, true);
      target = getWallHandle(targetId) ?? await awaitWallHandle(targetId);
      if (!target) throw new Error('The new Workspace did not mount');
      // Revalidate after the new Wall's passive registration; no prompt here.
      checkEndpoints();
    }
    // No await may separate this final dirty/kind check from departure.
    prepared = source.prepareSurfaceMove(id);
    if (prepared.iframe && !iframeConsented) throw new Error('This Surface started serving an iframe; retry the move to confirm its refresh');
    targetRecord = previousWorkspaceSession(targetId);
    invalidateWorkspaceSaves(targetId);
    const receiver = target!;
    let surfaceRef = '';
    flushSync(() => {
      undoDeparture = prepared.depart();
      try {
        const adopted = receiver.adoptSurfaceMove(id, prepared.meta);
        undoAdoption = adopted.rollback;
        surfaceRef = adopted.surfaceRef;
      } catch (error) { undoDeparture(); undoDeparture = undefined; throw error; }
      receiver.finishSurfaceMove();
      source.finishSurfaceMove();
    });
    // Mounting a new Wall can let saves collect the pre-departure layout. Fence
    // those too, once both ownership changes have completed synchronously.
    invalidateWorkspaceSaves(source.workspaceId);
    invalidateWorkspaceSaves(targetId);
    moveRetainedSurfaceRecord(id, source.workspaceId, targetId);
    const [sourceSession, targetSession] = await Promise.all([
      source.serializePersistence({ probeCwd: false }), receiver.serializePersistence({ probeCwd: false }),
    ]);
    publishWorkspaceSession(source.workspaceId, sourceSession);
    publishWorkspaceSession(targetId, targetSession);
    // Closing the source is irreversible. Later UI/notice failures must never
    // restore membership into a Wall that has already unmounted.
    committed = true;
    const sourceEmpty = source.surfaceIds().length === 0;
    flushSync(() => {
      if (sourceEmpty) discardWorkspace(source.workspaceId);
      if (gui || request.focus) {
        setActiveWorkspace(targetId!);
        receiver.focusSurface(id, gui);
      } else if (sourceEmpty && activeBefore === source.workspaceId) {
        setActiveWorkspace(targetId!); receiver.enterCommandMode();
      }
    });
    const workspaceRef = workspaceRefFor(targetId);
    if (prepared.terminal) {
      const moved = `Moved ${prepared.surfaceRef} from ${oldWorkspaceRef} to ${workspaceRef} ${surfaceRef}.`;
      const terminal = getTerminalInstance(id);
      if (terminal?.buffer.active.type === 'alternate') {
        receiver.showMoveNotice(id, `${moved} Cached surface:N refs now resolve here; use stable ID ${id}. Unscoped dor ensure can duplicate work left behind.`);
      } else {
        // Raw xterm write: keep host-minted refs and ids from carrying controls.
        const line = sanitizeText(`${moved} Stable ID: ${id}.`, 500);
        terminal?.write(`\r\n[Dormouse] ${line}\r\nShort surface:N refs now resolve in the destination Workspace; cached refs may target other panes. Unscoped dor ensure searches here and can duplicate a server left behind. Use stable IDs across moves.\r\n`);
      }
    }
    return { status: 'moved', surfaceId: id, surfaceRef, workspaceId: targetId, workspaceRef };
  } catch (error) {
    if (committed) throw error;
    invalidateWorkspaceSaves(source.workspaceId);
    if (targetId) invalidateWorkspaceSaves(targetId);
    flushSync(() => {
      undoAdoption?.(); undoDeparture?.();
      source.finishSurfaceMove(); target?.finishSurfaceMove();
      if (created && targetId) discardWorkspace(targetId);
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
