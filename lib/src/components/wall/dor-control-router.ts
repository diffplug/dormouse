import { createRefCount } from '../../lib/ref-count';
import { getActiveWorkspaceId, isWindowRef, workspaceIdForRef } from '../../lib/workspace-store';
import { getWallHandle, wallHandleOwning, type WallHandle } from './wall-handles';
import type { DorControlRequest } from './use-dor-control';

/**
 * The one window listener for `dormouse:control-request`, deciding which Wall
 * answers (`docs/specs/dor-cli.md` → "Handle Model"). It replaces the per-Wall
 * listener, which would have every mounted Workspace answer the same request.
 */

/** Where one control request lands. */
export type DorControlRoute =
  | { kind: 'handle'; handle: WallHandle }
  | { kind: 'error'; message: string }
  /** Nothing is mounted that could answer; the request is left to time out. */
  | { kind: 'none' };

/**
 * Resolution order: an explicit container target, else the caller's own
 * Workspace, else the active one. `surface:` targets are resolved by the chosen
 * Wall, within its own Workspace.
 */
export function resolveDorControlRoute(detail: DorControlRequest): DorControlRoute {
  const params = detail.params ?? {};
  // Typed before use: `params` is whatever crossed the control socket, and a
  // non-string ref reaching `.trim()` would throw out of the window listener,
  // leaving the caller to block until its own deadline.
  if (params.window !== undefined && (typeof params.window !== 'string' || !isWindowRef(params.window))) {
    return { kind: 'error', message: `unknown window target '${String(params.window)}'` };
  }
  if (params.workspace !== undefined) {
    // A ref of the wrong type, one outside the strip, and one whose Wall is not
    // mounted are the same answer: this Window has no such Workspace to route to.
    const ref = typeof params.workspace === 'string' ? workspaceIdForRef(params.workspace) : null;
    const handle = ref ? getWallHandle(ref) : null;
    return handle
      ? { kind: 'handle', handle }
      : { kind: 'error', message: `unknown workspace target '${String(params.workspace)}'` };
  }
  // The caller's own Workspace: `dor split` from a background Workspace lands
  // beside its caller, not in whichever Workspace the user is looking at.
  const owner = detail.surfaceId ? wallHandleOwning(detail.surfaceId) : null;
  if (owner) return { kind: 'handle', handle: owner };
  // An unknown caller (a shell started outside Dormouse, a killed Surface's
  // late request) is served by the Workspace the user is in.
  const active = getWallHandle(getActiveWorkspaceId());
  return active ? { kind: 'handle', handle: active } : { kind: 'none' };
}

/**
 * How many macrotasks a request waits for a Wall to appear. A Wall registers its
 * handle in a passive effect, so a request landing between `createWorkspace()`
 * and that effect — `dor workspace new && dor split`, the strip's `+` under a
 * scripted caller — finds nothing to route to. Retrying is what answers it
 * instead of dropping it; the bound keeps a Window with no Walls at all (a
 * Storybook strip) from retrying forever.
 */
const ROUTE_RETRIES = 5;

function dispatchDorControl(detail: DorControlRequest, attempt: number): void {
  const route = resolveDorControlRoute(detail);
  if (route.kind === 'error') {
    detail.respond({ ok: false, error: route.message });
    return;
  }
  if (route.kind === 'none') {
    if (attempt < ROUTE_RETRIES) setTimeout(() => dispatchDorControl(detail, attempt + 1), 0);
    return;
  }
  // Every failure the handler can raise is answered: an unanswered request
  // blocks its caller until the CLI's own deadline
  // (`docs/specs/dor-cli.md` → "Handle Model").
  const fail = (error: unknown) => detail.respond({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
  try {
    const running = route.handle.handleDorControl(detail) as unknown;
    if (running instanceof Promise) void running.catch(fail);
  } catch (error) {
    fail(error);
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
      dispatchDorControl(detail, 0);
    };
    window.addEventListener('dormouse:control-request', listener);
    return () => window.removeEventListener('dormouse:control-request', listener);
  },
});
