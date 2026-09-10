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
  if (params.window !== undefined && !isWindowRef(params.window)) {
    return { kind: 'error', message: `unknown window target '${params.window}'` };
  }
  if (params.workspace !== undefined) {
    // A ref outside the strip and one whose Wall is not mounted are the same
    // answer: this Window has no such Workspace to route to.
    const workspaceId = workspaceIdForRef(params.workspace);
    const handle = workspaceId ? getWallHandle(workspaceId) : null;
    return handle ? { kind: 'handle', handle } : { kind: 'error', message: `unknown workspace target '${params.workspace}'` };
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

let installCount = 0;
let listener: ((event: Event) => void) | null = null;

/**
 * Install the router's window listener, reference-counted so N Walls share one.
 * Returns its (idempotent) release.
 */
export function installDorControlRouter(): () => void {
  installCount += 1;
  if (installCount === 1) {
    listener = (event: Event) => {
      const detail = (event as CustomEvent<DorControlRequest>).detail;
      if (!detail) return;
      const route = resolveDorControlRoute(detail);
      if (route.kind === 'error') {
        detail.respond({ ok: false, error: route.message });
        return;
      }
      if (route.kind === 'none') return;
      route.handle.handleDorControl(detail);
    };
    window.addEventListener('dormouse:control-request', listener);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    installCount -= 1;
    if (installCount === 0 && listener) {
      window.removeEventListener('dormouse:control-request', listener);
      listener = null;
    }
  };
}
