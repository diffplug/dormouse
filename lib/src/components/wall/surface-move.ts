import { flushSync } from 'react-dom';
import type { MoveSurfaceRequest, MoveSurfaceResponse } from 'dor/commands/types';
import { surfaceRefForId } from 'dor/protocol';
import { closeWorkspace, createWorkspace, generateWorkspaceId, getActiveWorkspaceId, hasWorkspace, isWorkspacePinned, resolveWorkspaceRef, setActiveWorkspace, workspaceRefFor } from '../../lib/workspace-store';
import { forgetWorkspaceSession, invalidateWorkspaceSaves, isWorkspaceTransferPending, moveRetainedSurfaceRecord, publishWorkspaceSessions, setWorkspaceTransferPending } from '../../lib/window-session-aggregator';
import { cancelPendingConfirmation, dismissWorkspaceUi, requestConfirmation, setWorkspaceMoveError } from '../../lib/workspace-ui-store';
import type { WorkspaceId } from '../../lib/session-types';
import { sanitizeText } from '../../lib/osc-sanitize';
import { getTerminalInstance } from '../../lib/terminal-registry';
import { randomKillChar } from '../KillConfirm';
import { errorText } from './dor-control-shared';
import { forgetWorkspaceBootPlan, setWorkspaceBootPlan } from './workspace-boot-plans';
import { getWallHandle, wallHandleOwning, type WallHandle } from './wall-handles';

/** The move in flight, if any. A declined consent releases it synchronously,
 *  so whichever verb cancelled it can start at once. */
let moving: object | null = null;

const IFRAME_FLAG_REQUIRED = 'Moving this iframe reopens at its saved URL; pass --dangerously-destroy-iframe-page-state to accept losing page state';

/** Why `source` cannot move a Surface to `destination`, or null when it can:
 *  the coordinator, the drag's targets and the picker share it. */
export function surfaceMoveRefusal(source: WallHandle | null, destination: { workspace: WorkspaceId } | { new: true }): string | null {
  if (!source?.canMoveSurfaces) return 'This host does not support moving Surfaces between Workspaces';
  const target = 'workspace' in destination ? destination.workspace : null;
  if (target === source.workspaceId) return 'The Surface is already in that Workspace';
  if (!target && source.surfaceIds().length <= 1) return 'The only Surface is already in its own Workspace';
  if (isWorkspaceTransferPending(source.workspaceId) || (target && isWorkspaceTransferPending(target))) return 'A Workspace is already moving';
  return null;
}

/** False when the user declines, or when a newer verb cancels the question;
 *  a no releases the move before it resolves. */
function consent(source: WorkspaceId, release: () => void): Promise<boolean> {
  return new Promise(resolve => requestConfirmation({
    id: source,
    char: randomKillChar(),
    title: 'Move iframe?',
    detail: 'moving this iframe will trigger a refresh and reopen at its saved URL, possibly losing page state or returning to an earlier page.',
    cancelHint: 'anything else to cancel',
    answer: accepted => {
      if (!accepted) release();
      resolve(accepted);
    },
  }));
}

/** The same close tail as `closeWorkspaceWithSurfaces`, for a Wall left empty. */
function discardWorkspace(id: WorkspaceId): void {
  closeWorkspace(id);
  forgetWorkspaceSession(id);
  forgetWorkspaceBootPlan(id);
  dismissWorkspaceUi(id);
}

/** One coordinator for GUI and dor. Preparation and consent change no membership;
 * after the last await, departure, adoption and both records' publication run
 * in one synchronous step, reversible until both Walls finish. */
export async function moveSurface(id: string, request: Omit<MoveSurfaceRequest, 'surface' | 'workspace'>, gui = false): Promise<MoveSurfaceResponse | null> {
  // A move still awaiting its consent is answered no and released here.
  cancelPendingConfirmation();
  if (moving) throw new Error('Another Surface move is in progress');
  const owner = wallHandleOwning(id);
  const destination = request.destination;
  const resolved = 'workspace' in destination ? resolveWorkspaceRef(destination.workspace) : null;
  if (resolved && !resolved.ok) throw new Error(resolved.message);
  let targetId = resolved?.ok ? resolved.id : null;
  const refusal = surfaceMoveRefusal(owner, targetId ? { workspace: targetId } : { new: true });
  if (refusal) throw new Error(refusal);
  const source = owner!;
  const toNew = !targetId;
  let target: WallHandle | null = targetId ? getWallHandle(targetId) : null;
  /** Rechecked after every await: either Wall may close or remount meanwhile. */
  const checkEndpoints = () => {
    if (!hasWorkspace(source.workspaceId) || getWallHandle(source.workspaceId) !== source) throw new Error('The source Surface is no longer available');
    if (toNew && source.surfaceIds().length <= 1) throw new Error('The only Surface is already in its own Workspace');
    if (targetId && (!hasWorkspace(targetId) || !target?.canMoveSurfaces || getWallHandle(targetId) !== target)) throw new Error('The destination Workspace is unavailable');
  };
  checkEndpoints();
  let prepared = source.prepareSurfaceMove(id);
  let iframeConsented = request.dangerouslyDestroyIframePageState;
  if (prepared.iframe && !iframeConsented && !gui) throw new Error(IFRAME_FLAG_REQUIRED);
  /** False when the user cancels; a dor caller never sees a dialog. */
  const ensureIframeConsent = async (): Promise<boolean> => {
    if (!prepared.iframe || iframeConsented) return true;
    if (!gui) throw new Error(IFRAME_FLAG_REQUIRED);
    if (!await consent(source.workspaceId, release)) return false;
    iframeConsented = true;
    prepared = source.prepareSurfaceMove(id);
    return true;
  };
  const token = {};
  /** Idempotent, and inert once a newer move holds the guard. */
  const release = () => {
    if (moving !== token) return;
    moving = null;
    setWorkspaceTransferPending(source.workspaceId, false);
    if (targetId) setWorkspaceTransferPending(targetId, false);
  };
  moving = token;
  setWorkspaceTransferPending(source.workspaceId, true);
  if (targetId) setWorkspaceTransferPending(targetId, true);
  const activeBefore = getActiveWorkspaceId();
  const oldWorkspaceRef = workspaceRefFor(source.workspaceId);
  let created = false;
  let committed = false;
  let undoDeparture: (() => void) | undefined;
  let undoAdoption: (() => void) | undefined;
  try {
    if (!await ensureIframeConsent()) return null;
    // Neither a dialog nor a cwd probe reserves the Surface's kind or dirty state.
    await Promise.all([source.flushPersistence({ probeCwd: false }), target?.flushPersistence({ probeCwd: false })]);
    checkEndpoints();
    prepared = source.prepareSurfaceMove(id);
    // A Tool may start serving an iframe while the persistence flush awaits.
    if (!await ensureIframeConsent()) return null;
    checkEndpoints();
    // From here to the end nothing awaits: no save, write or verb interleaves.
    if (!targetId) {
      targetId = generateWorkspaceId();
      setWorkspaceBootPlan(targetId, { emptyForMove: true });
      // A synchronous render flushes the new Wall's registering effects.
      flushSync(() => createWorkspace({ id: targetId!, activate: false }));
      created = true;
      setWorkspaceTransferPending(targetId, true);
      target = getWallHandle(targetId);
      if (!target) throw new Error('The new Workspace did not mount');
      checkEndpoints();
    }
    prepared = source.prepareSurfaceMove(id);
    if (prepared.iframe && !iframeConsented) throw new Error('This Surface started serving an iframe; retry the move to confirm its refresh');
    // Fence saves collected before the ownership change, a new Wall's included.
    invalidateWorkspaceSaves(source.workspaceId);
    invalidateWorkspaceSaves(targetId);
    const receiver = target!;
    // Read after the last await: a pin set meanwhile keeps the source.
    const keepSource = isWorkspacePinned(source.workspaceId);
    flushSync(() => {
      undoDeparture = prepared.depart();
      try {
        undoAdoption = receiver.adoptSurfaceMove(id, prepared.meta);
      } catch (error) { undoDeparture(); undoDeparture = undefined; throw error; }
      receiver.finishSurfaceMove();
      // A pinned source is never discarded: it refills, as a kill of its last
      // pane does (`docs/specs/layout.md` → "Moving Surfaces between Workspaces").
      source.finishSurfaceMove({ keepEmpty: keepSource });
    });
    // React effects and store subscribers can collect saves synchronously
    // during the commit, before the retained cwd/alert migrates. Their promise
    // callbacks run later: fence them as well as pre-departure saves.
    invalidateWorkspaceSaves(source.workspaceId);
    invalidateWorkspaceSaves(targetId);
    // A finished Wall may have refilled, and closing the source is
    // irreversible: nothing after this point restores membership.
    committed = true;
    moveRetainedSurfaceRecord(id, source.workspaceId, targetId);
    publishWorkspaceSessions([[source.workspaceId, source.serializeNow()], [targetId, receiver.serializeNow()]]);
    const sourceEmpty = source.surfaceIds().length === 0 && !keepSource;
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
    const surfaceRef = surfaceRefForId(id);
    if (prepared.terminal) {
      const moved = `Moved ${surfaceRef} from ${oldWorkspaceRef} to ${workspaceRef}.`;
      const terminal = getTerminalInstance(id);
      if (terminal?.buffer.active.type === 'alternate') {
        receiver.showMoveNotice(id, `${moved} Unscoped dor ensure can duplicate work left behind.`);
      } else {
        // Raw xterm write: keep host-minted refs and ids from carrying controls.
        const line = sanitizeText(moved, 500);
        terminal?.write(`\r\n[Dormouse] ${line}\r\nUnscoped dor ensure searches here and can duplicate a server left behind.\r\n`);
      }
    }
    return { status: 'moved', surfaceId: id, surfaceRef, workspaceId: targetId, workspaceRef };
  } catch (error) {
    if (committed) throw error;
    flushSync(() => {
      undoAdoption?.(); undoDeparture?.();
      source.finishSurfaceMove(); target?.finishSurfaceMove();
      if (created && targetId) discardWorkspace(targetId);
      if (hasWorkspace(activeBefore)) setActiveWorkspace(activeBefore);
    });
    invalidateWorkspaceSaves(source.workspaceId);
    if (targetId) invalidateWorkspaceSaves(targetId);
    throw error;
  } finally {
    release();
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
