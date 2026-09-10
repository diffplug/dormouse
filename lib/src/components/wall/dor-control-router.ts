import { isWorkspaceControlMethod, SURFACE_CONTROL_METHODS } from 'dor/protocol';
import { createRefCount } from '../../lib/ref-count';
import { getActiveWorkspaceId, isWindowRef, resolveWorkspaceRef } from '../../lib/workspace-store';
import { errorText, mountingRefusal, ROUTE_RETRIES } from './dor-control-shared';
import { getWallHandle, wallHandleOwning, type WallHandle } from './wall-handles';
import { handleWorkspaceControl, listAllWorkspaceSurfaces, type WindowControlParams } from './workspace-control';
import { classifySurfaceTarget, type DorControlRequest } from './use-dor-control';

/**
 * The one window listener for `dormouse:control-request`, deciding which Wall
 * answers (`docs/specs/dor-cli.md` → "Handle Model"). It replaces the per-Wall
 * listener, which would have every mounted Workspace answer the same request.
 * The container verbs and the cross-Workspace listing are answered here instead,
 * by `workspace-control.ts`.
 */

/** Where one control request lands. */
export type DorControlRoute =
  | { kind: 'handle'; handle: WallHandle }
  /** Answered by the Window itself: a `workspace.*` container verb
   *  (`container: true`), or the `--all` listing that spans them. */
  | { kind: 'window'; container: boolean }
  | { kind: 'error'; message: string }
  /** The Workspace exists but its Wall has not registered yet: retried like
   *  `none`, and answered with `message` if it never does. */
  | { kind: 'pending'; message: string }
  /** Nothing is mounted that could answer; the request is left to time out. */
  | { kind: 'none' };

/**
 * The Workspace holding the Surface this target names, when the target names
 * one Window-wide: only a stable id does (`classifySurfaceTarget`). `surface:N`
 * is Workspace-scoped — every Workspace has a `surface:1` — so it stays with
 * the Wall that answers.
 */
function wallHandleOwningTarget(target: unknown): WallHandle | null {
  if (typeof target !== 'string') return null;
  const classified = classifySurfaceTarget(target);
  return classified.kind === 'stable' ? wallHandleOwning(classified.id) : null;
}

/**
 * Resolution order: the Window's own verbs, an explicit container target, a
 * target Surface named by its stable id, else the caller's own Workspace, else
 * the active one. `surface:N` targets are resolved by the chosen Wall, within
 * its own Workspace.
 */
export function resolveDorControlRoute(detail: DorControlRequest): DorControlRoute {
  const params: WindowControlParams = detail.params ?? {};
  // Typed before use: `params` is whatever crossed the control socket, and a
  // non-string ref reaching `.trim()` would throw out of the window listener,
  // leaving the caller to block until its own deadline.
  if (params.window !== undefined && (typeof params.window !== 'string' || !isWindowRef(params.window))) {
    return { kind: 'error', message: `unknown window target '${String(params.window)}'` };
  }
  // Container verbs belong to no Workspace, and `--all` spans them all.
  if (isWorkspaceControlMethod(detail.method)) return { kind: 'window', container: true };
  if (detail.method === SURFACE_CONTROL_METHODS.list && params.scope === 'all') {
    return { kind: 'window', container: false };
  }
  if (params.workspace !== undefined) {
    // A ref of the wrong type and one outside the strip name no Workspace of
    // this Window. One whose Wall has simply not registered yet is a different
    // answer — the Workspace is there — so it waits like `none` instead.
    const resolved = typeof params.workspace === 'string'
      ? resolveWorkspaceRef(params.workspace)
      : { ok: false as const, message: `unknown workspace target '${String(params.workspace)}'` };
    if (!resolved.ok) return { kind: 'error', message: resolved.message };
    const handle = getWallHandle(resolved.id);
    return handle
      ? { kind: 'handle', handle }
      : { kind: 'pending', message: mountingRefusal(String(params.workspace).trim()) };
  }
  // A stable id names one Surface in the whole Window, so a command targeting
  // one is answered by whichever Workspace holds it, caller or not.
  const owningTarget = wallHandleOwningTarget(params.surface);
  if (owningTarget) return { kind: 'handle', handle: owningTarget };
  // The caller's own Workspace: `dor split` from a background Workspace lands
  // beside its caller, not in whichever Workspace the user is looking at.
  const owner = detail.surfaceId ? wallHandleOwning(detail.surfaceId) : null;
  if (owner) return { kind: 'handle', handle: owner };
  // An unknown caller (a shell started outside Dormouse, a killed Surface's
  // late request) is served by the Workspace the user is in.
  const active = getWallHandle(getActiveWorkspaceId());
  return active ? { kind: 'handle', handle: active } : { kind: 'none' };
}

function dispatchDorControl(detail: DorControlRequest, attempt: number): void {
  const route = resolveDorControlRoute(detail);
  if (route.kind === 'error') {
    detail.respond({ ok: false, error: route.message });
    return;
  }
  if (route.kind === 'none' || route.kind === 'pending') {
    if (attempt < ROUTE_RETRIES) {
      setTimeout(() => dispatchDorControl(detail, attempt + 1), 0);
      return;
    }
    // A Workspace whose Wall never registered says so; a Window with nothing
    // mounted at all has nobody to answer for, and is left to time out.
    if (route.kind === 'pending') detail.respond({ ok: false, error: route.message });
    return;
  }
  // Every failure the handler can raise is answered: an unanswered request
  // blocks its caller until the CLI's own deadline
  // (`docs/specs/dor-cli.md` → "Handle Model").
  const fail = (error: unknown) => detail.respond({ ok: false, error: errorText(error) });
  try {
    const running = route.kind === 'window'
      ? (route.container ? handleWorkspaceControl(detail) : listAllWorkspaceSurfaces(detail))
      : (route.handle.handleDorControl(callerFor(route.handle, detail)) as unknown);
    if (running instanceof Promise) void running.catch(fail);
  } catch (error) {
    fail(error);
  }
}

/**
 * The request as the answering Wall sees it: a caller that Wall does not hold
 * is dropped here, so `surface:self` and an omitted target fall back to that
 * Workspace's own focused Surface rather than naming a Surface no consumer down
 * there can find. Rewritten once, at the seam, instead of re-checked by every
 * consumer of the caller id.
 */
function callerFor(handle: WallHandle, detail: DorControlRequest): DorControlRequest {
  if (!detail.surfaceId || handle.ownsSurface(detail.surfaceId)) return detail;
  return { ...detail, surfaceId: undefined };
}

/**
 * Install the router's window listener, reference-counted so N Walls share one.
 * Returns its (idempotent) release.
 */
export const installDorControlRouter = createRefCount({
  onFirst: () => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<DorControlRequest>).detail;
      if (!detail) return;
      dispatchDorControl(detail, 0);
    };
    window.addEventListener('dormouse:control-request', listener);
    return () => window.removeEventListener('dormouse:control-request', listener);
  },
});
