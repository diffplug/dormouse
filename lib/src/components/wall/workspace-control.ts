import { WORKSPACE_CONTROL_METHODS } from 'dor/protocol';
import type { DorControlResult } from 'dor/protocol';
import type { Surface as DorSurface, ListSurfacesResponse, WorkspaceRow } from 'dor/commands/types';
import { getActivitySnapshot } from '../../lib/session-activity-store';
import type { WorkspaceId } from '../../lib/session-types';
import {
  createWorkspace,
  currentWindowRef,
  getWorkspacesSnapshot,
  renameWorkspace,
  resolveWorkspaceRef,
  setActiveWorkspace,
  workspaceRefFor,
} from '../../lib/workspace-store';
import { getWorkspaceSurfacesSnapshot } from '../../lib/workspace-surfaces';
import { computeWorkspaceUnion } from '../../lib/workspace-union';
import { getWallHandle, type WallHandle } from './wall-handles';
import { closeWorkspaceWithSurfaces, workspaceNeedsCloseConfirmation } from './workspace-lifecycle';
import type { DorControlParams, DorControlRequest } from './use-dor-control';

/**
 * The Window-level half of the `dor` control plane: the `workspace.*` container
 * verbs, and the `surface.list --all` fan-out across every mounted Wall
 * (`docs/specs/dor-cli.md` → "dor workspace"). A Wall answers for the Surfaces
 * it holds; nothing below belongs to one Workspace, so the router answers it
 * here instead of handing it to a Wall.
 */

export function isWorkspaceControlMethod(method: string): boolean {
  return (Object.values(WORKSPACE_CONTROL_METHODS) as string[]).includes(method);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** This Window's Workspaces in strip order, each with its union status. */
export function workspaceRows(): WorkspaceRow[] {
  const { workspaces, activeId } = getWorkspacesSnapshot();
  const membership = getWorkspaceSurfacesSnapshot();
  const activity = getActivitySnapshot();
  return workspaces.map((workspace, index) => {
    const union = computeWorkspaceUnion(membership.get(workspace.id) ?? [], activity);
    return {
      ref: `workspace:${index + 1}`,
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
 * **A Workspace that fails to list fails the whole call** rather than dropping
 * out of the answer, which would read as a Workspace holding nothing.
 */
export async function listAllWorkspaceSurfaces(detail: DorControlRequest): Promise<void> {
  const params = detail.params ?? {};
  const rows = workspaceRows();
  const surfaces: DorSurface[] = [];
  for (const row of rows) {
    const handle = getWallHandle(row.id as WorkspaceId);
    // A Workspace whose Wall is not mounted contributes nothing; every
    // Workspace of a multi-Workspace Window keeps its Wall mounted, so this is
    // the tick between `createWorkspace` and the Wall registering.
    if (!handle) continue;
    const answer = await askWall(handle, detail, { ...params, scope: 'workspace', workspace: undefined });
    if (!answer.ok) {
      detail.respond({ ok: false, error: `${row.ref}: ${answer.error ?? 'listing failed'}` });
      return;
    }
    const listed = answer.result as ListSurfacesResponse;
    for (const surface of listed.surfaces) surfaces.push({ ...surface, workspaceRef: row.ref });
  }
  detail.respond({
    ok: true,
    result: {
      surfaces,
      workspaces: rows,
      workspaceRef: workspaceRefFor(getWorkspacesSnapshot().activeId),
      windowRef: currentWindowRef(),
    } satisfies ListSurfacesResponse,
  });
}

/** The Workspace a mutating verb names, or null once the failure is answered. */
function requireWorkspace(
  detail: DorControlRequest,
): { id: WorkspaceId; ref: string; name: string } | null {
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
  const meta = getWorkspacesSnapshot().workspaces.find((workspace) => workspace.id === resolved.id);
  if (!meta) {
    detail.respond({ ok: false, error: `unknown workspace target '${target}'` });
    return null;
  }
  return { id: meta.id, ref: workspaceRefFor(meta.id), name: meta.name };
}

/** Answer one `workspace.*` request. Every path responds, including a throw. */
export async function handleWorkspaceControl(detail: DorControlRequest): Promise<void> {
  const params = detail.params ?? {};

  if (detail.method === WORKSPACE_CONTROL_METHODS.list) {
    detail.respond({ ok: true, result: { workspaces: workspaceRows(), windowRef: currentWindowRef() } });
    return;
  }

  if (detail.method === WORKSPACE_CONTROL_METHODS.new) {
    const name = stringParam(params.name)?.trim();
    // Created in the background: a command that moved the user to another
    // Workspace would be a bigger theft than the focus one `dor split` avoids
    // (`docs/specs/dor-cli.md` → "dor workspace"). `dor workspace switch` is
    // the verb that activates.
    const meta = createWorkspace({ ...(name ? { name } : {}), activate: false });
    detail.respond({
      ok: true,
      result: {
        status: 'created',
        workspaceId: meta.id,
        workspaceRef: workspaceRefFor(meta.id),
        name: meta.name,
      },
    });
    return;
  }

  if (detail.method === WORKSPACE_CONTROL_METHODS.rename) {
    const target = requireWorkspace(detail);
    if (!target) return;
    const name = stringParam(params.name)?.trim();
    if (!name) {
      detail.respond({ ok: false, error: 'name is required' });
      return;
    }
    renameWorkspace(target.id, name);
    detail.respond({
      ok: true,
      result: { status: 'renamed', workspaceId: target.id, workspaceRef: target.ref, name },
    });
    return;
  }

  if (detail.method === WORKSPACE_CONTROL_METHODS.switch) {
    const target = requireWorkspace(detail);
    if (!target) return;
    setActiveWorkspace(target.id);
    detail.respond({
      ok: true,
      result: { status: 'active', workspaceId: target.id, workspaceRef: target.ref, name: target.name },
    });
    return;
  }

  if (detail.method === WORKSPACE_CONTROL_METHODS.close) {
    const target = requireWorkspace(detail);
    if (!target) return;
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
    detail.respond({
      ok: true,
      result: { status: 'closed', workspaceId: target.id, workspaceRef: target.ref, name: target.name },
    });
    return;
  }

  detail.respond({ ok: false, error: `unsupported Dormouse control method '${detail.method}'` });
}
