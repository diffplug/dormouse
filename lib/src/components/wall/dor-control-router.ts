import { isAppControlMethod, isToolControlMethod, isWindowControlMethod, isWorkspaceControlMethod, parseSurfaceTarget, SURFACE_CONTROL_METHODS } from 'dor/protocol';
import { registry, isHelperSession } from '../../lib/terminal-store';
import { createRefCount } from '../../lib/ref-count';
import { getPendingKill, isPendingKillSession } from '../../lib/pending-kills';
import { getActiveWorkspaceId, isWindowRef, resolveWorkspaceRef, workspaceRefFor } from '../../lib/workspace-store';
import { handleAppControl } from './app-control';
import { handleReopenControl } from './reopen';
import { handleToolControl } from './tool-control';
import { errorText, mountingRefusal, requestForWall, ROUTE_RETRIES } from './dor-control-shared';
import { getWallHandle, wallHandleOwning, type WallHandle } from './wall-handles';
import { handleWorkspaceControl, listAllWorkspaceSurfaces, type WindowControlParams } from './workspace-control';
import type { DorControlRequest } from './use-dor-control';

/**
 * The one window listener for `dormouse:control-request`, deciding which Wall
 * answers (`docs/specs/dor-cli.md` → "Handle Model"). It replaces the per-Wall
 * listener, which would have every mounted Workspace answer the same request.
 * The container verbs and the cross-Workspace listing are answered here instead,
 * by `workspace-control.ts`, the app verbs by `app-control.ts`, and the Tool
 * configuration reads by `tool-control.ts`.
 */

/** Where one control request lands. */
export type DorControlRoute =
  | { kind: 'handle'; handle: WallHandle }
  /** Answered by the Window before anything is resolved: an `app.*` verb acts
   *  on the running app, so no param of its names a Workspace or Surface. */
  | { kind: 'app' }
  /** Answered by the Window before anything is resolved: a `tool.*` read of
   *  the Tool configuration names no Workspace or Surface either. */
  | { kind: 'tool' }
  /** Answered by the Window before anything is resolved: a `window.*` verb
   *  takes the Window's own reopen stack. */
  | { kind: 'reopen' }
  /** Answered by the Window itself: a `workspace.*` container verb
   *  (`container: true`), or the `--all` listing that spans them. */
  | { kind: 'window'; container: boolean }
  | { kind: 'error'; message: string }
  /** The Workspace exists but its Wall has not registered yet: retried like
   *  `none`, and answered with `message` if it never does. */
  | { kind: 'pending'; message: string }
  /** Nothing is mounted that could answer: retried, and answered with
   *  `message` — the active Workspace still mounting — if nothing ever does. */
  | { kind: 'none'; message: string };

/** The Workspace holding the Surface this target names by id or ref
 *  (`parseSurfaceTarget`); either names one Surface Window-wide. */
function wallHandleOwningTarget(target: unknown): WallHandle | null {
  if (typeof target !== 'string') return null;
  const parsed = parseSurfaceTarget(target);
  return parsed.kind === 'id' ? wallHandleOwning(parsed.id) : null;
}

/** The host supplies this before cross-window routing. In-process requests
 * (OSC, fake adapter) capture the same origin from the renderer registry, once
 * on arrival, so a promotion during route retries cannot clear it. */
function withHelperOrigin(detail: DorControlRequest): DorControlRequest {
  if (detail.helperParentId || !detail.surfaceId) return detail;
  const parent = registry.get(detail.surfaceId)?.helper?.parentId;
  return parent ? { ...detail, helperParentId: parent } : detail;
}

/**
 * Resolution order: the app verbs, the Tool reads, the Window's own verbs, an explicit
 * container target, the Workspace holding a target Surface named by id or
 * ref, else the caller's own Workspace, else the active one.
 */
export function resolveDorControlRoute(detail: DorControlRequest): DorControlRoute {
  const route = resolveRoute(detail);
  // A pending kill's Wall stays mounted off the strip, and a pending Session
  // keeps its process: neither may be reached, nor call into its Wall
  // (`docs/specs/reopen.md` → "Labs: No-confirm delayed kill").
  if (route.kind === 'handle' && getPendingKill('workspace', route.handle.workspaceId)) {
    return { kind: 'error', message: `workspace '${workspaceRefFor(route.handle.workspaceId)}' is a pending kill` };
  }
  // A helper's request names its parent; a pending helper is itself the caller.
  const caller = [detail.surfaceId, detail.helperParentId].find(id => id && isPendingKillSession(id));
  if (caller) return { kind: 'error', message: `surface '${caller}' is a pending kill` };
  return route;
}

function resolveRoute(detail: DorControlRequest): DorControlRoute {
  if (isAppControlMethod(detail.method)) return { kind: 'app' };
  if (isToolControlMethod(detail.method)) return { kind: 'tool' };
  if (isWindowControlMethod(detail.method)) return { kind: 'reopen' };
  const params: WindowControlParams = detail.params ?? {};
  if (typeof params.surface === 'string') {
    const target = parseSurfaceTarget(params.surface);
    if ((target.kind === 'self' && detail.helperParentId)
      || (target.kind === 'id' && isHelperSession(target.id))) {
      return { kind: 'error', message: 'Helper terminals are not public Surface targets; promote the helper first' };
    }
  }
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
  // An id or ref names one Surface in the whole Window, so a command targeting
  // one is answered by whichever Workspace holds it, caller or not.
  const owningTarget = wallHandleOwningTarget(params.surface);
  if (owningTarget) return { kind: 'handle', handle: owningTarget };
  // The caller's own Workspace: `dor split` from a background Workspace lands
  // beside its caller, not in whichever Workspace the user is looking at.
  const callerAnchor = detail.helperParentId ?? detail.surfaceId;
  const owner = callerAnchor ? wallHandleOwning(callerAnchor) : null;
  if (owner) return { kind: 'handle', handle: owner };
  // The source's Wall may still be registering (a reload, a Workspace transfer).
  if (detail.helperParentId) return { kind: 'pending', message: 'The helper source Surface is no longer available' };
  // An unknown caller (a shell started outside Dormouse, a killed Surface's
  // late request) is served by the Workspace the user is in.
  const activeId = getActiveWorkspaceId();
  const active = getWallHandle(activeId);
  return active
    ? { kind: 'handle', handle: active }
    : { kind: 'none', message: mountingRefusal(workspaceRefFor(activeId)) };
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
    // The Workspace that would have answered says it is still mounting — the
    // one named, or the active one when nothing is mounted at all. Dropping
    // the request instead would hold the caller to its own deadline, and
    // `dor agent-browser` makes this round trip on every managed invocation
    // (`docs/specs/dor-browser.md` → "Managed identity").
    detail.respond({ ok: false, error: route.message });
    return;
  }
  // Every failure the handler can raise is answered: an unanswered request
  // blocks its caller until the CLI's own deadline
  // (`docs/specs/dor-cli.md` → "Handle Model").
  const fail = (error: unknown) => detail.respond({ ok: false, error: errorText(error) });
  try {
    const running = runRoute(route, detail);
    if (running instanceof Promise) void running.catch(fail);
  } catch (error) {
    fail(error);
  }
}

function runRoute(route: Extract<DorControlRoute, { kind: 'app' | 'tool' | 'reopen' | 'window' | 'handle' }>, detail: DorControlRequest): unknown {
  switch (route.kind) {
    case 'app': return handleAppControl(detail);
    case 'reopen': return handleReopenControl(detail);
    case 'tool': return handleToolControl(detail);
    case 'window': return route.container ? handleWorkspaceControl(detail) : listAllWorkspaceSurfaces(detail);
    case 'handle': return route.handle.handleDorControl(requestForWall(route.handle, detail));
  }
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
      dispatchDorControl(withHelperOrigin(detail), 0);
    };
    window.addEventListener('dormouse:control-request', listener);
    return () => window.removeEventListener('dormouse:control-request', listener);
  },
});
