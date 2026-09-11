import { isWorkspaceControlMethod, WORKSPACE_CONTROL_METHODS } from 'dor/protocol';
import type { DorControlResult } from 'dor/protocol';
import type {
  GroupedSurface,
  ListSurfacesResponse,
  WorkspaceMutationResponse,
  WorkspaceRow,
} from 'dor/commands/types';
import { getPlatformOrNull } from '../../lib/platform';
import { getActivitySnapshot } from '../../lib/session-activity-store';
import type { WorkspaceId } from '../../lib/session-types';
import {
  createWorkspace,
  currentWindowRef,
  getWorkspacesSnapshot,
  isWindowRef,
  moveWorkspace,
  renameWorkspace,
  resolveWorkspaceRef,
  setActiveWorkspace,
  workspaceRefFor,
  type ResolvedWorkspace,
} from '../../lib/workspace-store';
import { getWorkspaceSurfacesSnapshot } from '../../lib/workspace-surfaces';
import { computeWorkspaceUnion } from '../../lib/workspace-union';
import { awaitWallHandle, errorText, mountingRefusal, stringParam } from './dor-control-shared';
import { attachSurfacePorts } from './surface-ports';
import type { WallHandle } from './wall-handles';
import { closeWorkspaceWithSurfaces, workspaceNeedsCloseConfirmation } from './workspace-lifecycle';
import type { DorControlParams, DorControlRequest } from './use-dor-control';

/**
 * The Window-level half of the `dor` control plane: the `workspace.*` container
 * verbs, and the `surface.list --all` fan-out across every mounted Wall
 * (`docs/specs/dor-cli.md` → "dor workspace"). A Wall answers for the Surfaces
 * it holds; nothing below belongs to one Workspace, so the router answers it
 * here instead of handing it to a Wall.
 */

/** What the Window reads on top of a Wall's params: the listing's reach and the
 *  container verbs' own arguments. */
export type WindowControlParams = DorControlParams & {
  scope?: unknown;
  name?: unknown;
  force?: unknown;
  toWindow?: unknown;
  index?: unknown;
  dangerouslyDestroyIframePageState?: unknown;
};

/** This Window's Workspaces in strip order, each with its union status. */
export function workspaceRows(): WorkspaceRow[] {
  const { workspaces, activeId } = getWorkspacesSnapshot();
  const membership = getWorkspaceSurfacesSnapshot();
  const activity = getActivitySnapshot();
  return workspaces.map((workspace) => {
    const union = computeWorkspaceUnion(membership.get(workspace.id) ?? [], activity);
    return {
      ref: workspaceRefFor(workspace.id),
      id: workspace.id,
      name: workspace.name,
      active: workspace.id === activeId,
      ringing: union.ringing,
      todo: union.todo,
      count: union.count,
    };
  });
}

/**
 * Run one request against a Wall and resolve with whatever it answers. The
 * fan-out needs the answer rather than the caller's `respond`, so it hands each
 * Wall a `respond` of its own; a handler that throws or rejects settles as an
 * error, like the router's own dispatch.
 */
function askWall(
  handle: WallHandle,
  detail: DorControlRequest,
  params: DorControlParams,
): Promise<DorControlResult> {
  return new Promise((resolve) => {
    let settled = false;
    const respond = (response: DorControlResult) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    try {
      const running = handle.handleDorControl({ ...detail, params, respond }) as unknown;
      if (running instanceof Promise) void running.catch((error) => respond({ ok: false, error: errorText(error) }));
    } catch (error) {
      respond({ ok: false, error: errorText(error) });
    }
  });
}

/**
 * `dor list --all`: every Workspace's Surfaces in one answer, each row tagged
 * with the Workspace it came from and the directory of Workspaces beside them.
 * **A Workspace that cannot answer fails the whole call** — a Wall that never
 * registers included, after the router's own registration-gap wait — rather than
 * dropping out of the answer, which would read as a Workspace holding nothing.
 */
export async function listAllWorkspaceSurfaces(detail: DorControlRequest): Promise<void> {
  const params: WindowControlParams = detail.params ?? {};
  const rows = workspaceRows();
  const includePorts = params.includePorts === true;
  // Asked in parallel, assembled in strip order. The port scan is **not**
  // forwarded: a Wall would scan its own terminals, so N Workspaces would cost N
  // process scans; this listing runs one for all of them below.
  const answers = await Promise.all(rows.map(async (row) => {
    const handle = await awaitWallHandle(row.id as WorkspaceId);
    return {
      row,
      answer: handle
        ? await askWall(handle, detail, { ...params, workspace: undefined, includePorts: false })
        : null,
    };
  }));

  const surfaces: GroupedSurface[] = [];
  for (const { row, answer } of answers) {
    if (!answer) {
      detail.respond({ ok: false, error: mountingRefusal(row.ref) });
      return;
    }
    if (!answer.ok) {
      detail.respond({ ok: false, error: `${row.ref}: ${answer.error ?? 'listing failed'}` });
      return;
    }
    const listed = answer.result as ListSurfacesResponse;
    for (const surface of listed.surfaces) {
      // Each Wall marks its own selection focused, but the Window has one focus:
      // a row of an inactive Workspace is not it (`docs/specs/dor-cli.md` →
      // "Current Implemented Commands").
      surfaces.push({ ...surface, workspaceRef: row.ref, focused: surface.focused && row.active });
    }
  }

  detail.respond({
    ok: true,
    result: {
      surfaces: includePorts ? await attachSurfacePorts(surfaces) : surfaces,
      workspaces: rows,
      workspaceRef: (rows.find((row) => row.active) ?? rows[0]).ref,
      windowRef: currentWindowRef(),
    } satisfies ListSurfacesResponse,
  });
}

/** The Workspace a mutating verb names, or null once the failure is answered. */
function requireWorkspace(detail: DorControlRequest): ResolvedWorkspace | null {
  const target = stringParam(detail.params?.workspace);
  if (!target) {
    detail.respond({ ok: false, error: 'workspace is required' });
    return null;
  }
  const resolved = resolveWorkspaceRef(target);
  if (!resolved.ok) {
    detail.respond({ ok: false, error: resolved.message });
    return null;
  }
  return resolved;
}

/** Answer one `workspace.*` request. Every path responds, including a throw. */
export async function handleWorkspaceControl(detail: DorControlRequest): Promise<void> {
  const params: WindowControlParams = detail.params ?? {};
  const name = stringParam(params.name)?.trim();

  /** The one shape every mutating verb answers with. */
  const respondMutation = (
    status: WorkspaceMutationResponse['status'],
    workspace: ResolvedWorkspace,
    renamedTo?: string,
  ) => detail.respond({
    ok: true,
    result: {
      status,
      workspaceId: workspace.id,
      workspaceRef: workspace.ref,
      name: renamedTo ?? workspace.name,
    } satisfies WorkspaceMutationResponse,
  });

  // Narrowed before the switch, whose exhaustiveness is then what makes a new
  // container verb a compile error here rather than a silent no-op.
  if (!isWorkspaceControlMethod(detail.method)) {
    detail.respond({ ok: false, error: `unsupported Dormouse control method '${detail.method}'` });
    return;
  }
  switch (detail.method) {
    case WORKSPACE_CONTROL_METHODS.list: {
      detail.respond({ ok: true, result: { workspaces: workspaceRows(), windowRef: currentWindowRef() } });
      return;
    }

    case WORKSPACE_CONTROL_METHODS.new: {
      // Created in the background: a command that moved the user to another
      // Workspace would be a bigger theft than the focus one `dor split` avoids
      // (`docs/specs/dor-cli.md` → "dor workspace"). `dor workspace switch` is
      // the verb that activates.
      const meta = createWorkspace({ ...(name ? { name } : {}), activate: false });
      respondMutation('created', { ...meta, ref: workspaceRefFor(meta.id) });
      return;
    }

    case WORKSPACE_CONTROL_METHODS.rename: {
      const target = requireWorkspace(detail);
      if (!target) return;
      if (!name) {
        detail.respond({ ok: false, error: 'name is required' });
        return;
      }
      renameWorkspace(target.id, name);
      respondMutation('renamed', target, name);
      return;
    }

    case WORKSPACE_CONTROL_METHODS.switch: {
      const target = requireWorkspace(detail);
      if (!target) return;
      setActiveWorkspace(target.id);
      respondMutation('active', target);
      return;
    }

    case WORKSPACE_CONTROL_METHODS.move: {
      const target = requireWorkspace(detail);
      if (!target) return;
      const toWindow = stringParam(params.toWindow)?.trim();
      const index = typeof params.index === 'number' && Number.isInteger(params.index) && params.index >= 0
        ? params.index : undefined;
      if (toWindow === undefined && index === undefined) {
        detail.respond({ ok: false, error: 'workspace.move needs a window, an index, or both' });
        return;
      }
      if (toWindow !== undefined && !isWindowRef(toWindow)) {
        const handle = await awaitWallHandle(target.id);
        if (!handle) {
          detail.respond({ ok: false, error: mountingRefusal(target.ref) });
          return;
        }
        const platform = getPlatformOrNull();
        if (!platform?.transferWorkspace) {
          detail.respond({ ok: false, error: 'this host has one window; workspace.move can only reorder here' });
          return;
        }
        // The one thing a move between Windows cannot carry is a plain
        // iframe's document: it reopens at its saved URL, its page state gone
        // (`docs/specs/layout.md` → Workspaces). The caller says so explicitly.
        const iframes = handle.iframeSurfaceIds();
        if (iframes.length > 0 && params.dangerouslyDestroyIframePageState !== true) {
          const refs = iframes.map((id) => `surface:${id}`).join(', ');
          detail.respond({
            ok: false,
            error: `workspace '${target.ref}' holds ${iframes.length} iframe Surface(s) whose page state a move destroys (${refs}); `
              + 'pass --dangerously-destroy-iframe-page-state to move it anyway',
          });
          return;
        }
        const label = toWindow.startsWith('window:') ? toWindow.slice('window:'.length) : toWindow;
        // The index travels with it: the slot it names is in the target's strip.
        // `moved` only once that Window has adopted the Workspace; one handed
        // back is an error naming why, and it is still here
        // (`docs/specs/dor-cli.md` → "dor workspace").
        try {
          await platform.transferWorkspace(target.id, label, index === undefined ? {} : { index });
        } catch (err) {
          detail.respond({ ok: false, error: `workspace '${target.ref}' was not moved: ${errorText(err)}` });
          return;
        }
        respondMutation('moved', target);
        return;
      }
      if (index !== undefined) moveWorkspace(target.id, index);
      respondMutation('moved', target);
      return;
    }

    case WORKSPACE_CONTROL_METHODS.close: {
      const target = requireWorkspace(detail);
      if (!target) return;
      // A close is answered only once the Workspace's Wall is there to answer
      // for it: the Wall is what knows the member Surfaces, so closing past a
      // missing one would drop the Workspace with its Sessions still running
      // (`docs/specs/glossary.md` → "Invariants" I4).
      if (!await awaitWallHandle(target.id)) {
        detail.respond({ ok: false, error: mountingRefusal(target.ref) });
        return;
      }
      // Like `dor kill`, a command close raises no prompt: it refuses instead,
      // and `--force` is the caller's answer to the confirmation the strip would
      // have shown (`docs/specs/dor-cli.md` → "dor workspace").
      if (params.force !== true && workspaceNeedsCloseConfirmation(target.id)) {
        detail.respond({
          ok: false,
          error: `workspace '${target.ref}' holds running or touched Surfaces; pass --force to close it`,
        });
        return;
      }
      const refusal = await closeWorkspaceWithSurfaces(target.id, 'silent');
      if (refusal) {
        detail.respond({ ok: false, error: `workspace '${target.ref}' was not closed: ${refusal}` });
        return;
      }
      respondMutation('closed', target);
      return;
    }
  }
}
