/**
 * VS Code maps each Workspace to a webview of its own (`docs/specs/vscode.md` →
 * Workspaces), so this host has no Window-wide Workspace model to answer with:
 * a Workspace-spanning `dor` request would report one webview's Workspace as if
 * it were all of them, and a mutation would move a strip that does not exist.
 * This host serves exactly the one Workspace each webview is — `workspace:1` —
 * and refuses everything that spans, at the extension host, before the request
 * reaches a webview.
 */

import { SURFACE_CONTROL_METHODS, WORKSPACE_CONTROL_METHODS, parseWorkspaceRef, spansWorkspaces } from 'dor/protocol';
import { DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_NAME } from '../../lib/src/lib/session-types';

const REFUSAL = 'Dormouse in VS Code puts each Workspace in its own webview, so';

/**
 * Whether a container ref names the one Workspace this webview *is*: its id, or
 * the name a bare Wall registers — a caller that read either out of `dor list`
 * must be able to hand it straight back
 * (`docs/specs/dor-cli.md` → "Handle Model").
 */
function namesThisWebviewsWorkspace(workspace: unknown): boolean {
  if (typeof workspace !== 'string') return false;
  const { id, name } = parseWorkspaceRef(workspace);
  return id === DEFAULT_WORKSPACE_ID || name === DEFAULT_WORKSPACE_NAME;
}

/** The command a caller ran to send a Workspace-spanning request, so the
 *  refusal names what they typed: agents act on this text. */
function spanningCommand(method: string, params: Record<string, unknown> | undefined): string {
  if (method === SURFACE_CONTROL_METHODS.move) return 'dor move';
  if (method === WORKSPACE_CONTROL_METHODS.list) return 'dor list --workspaces';
  if (method === SURFACE_CONTROL_METHODS.list) return 'dor list --all';
  if (method === WORKSPACE_CONTROL_METHODS.pin && params?.pinned === false) return 'dor workspace unpin';
  return `dor workspace ${method.slice('workspace.'.length)}`;
}

/**
 * Why this request cannot be answered here, or null to let it through. Reads
 * only the wire request, so it holds for every transport that reaches the
 * extension host.
 */
export function dorWorkspaceRefusal(method: string, params: Record<string, unknown> | undefined): string | null {
  const workspace = params?.workspace;
  if (workspace !== undefined && !namesThisWebviewsWorkspace(workspace)) {
    return `${REFUSAL} it has no workspace '${String(workspace)}': this webview is ${DEFAULT_WORKSPACE_ID}, ${JSON.stringify(DEFAULT_WORKSPACE_NAME)}`;
  }
  if (spansWorkspaces(method, params)) {
    return `${REFUSAL} ${spanningCommand(method, params)} is not available here: it spans Workspaces`;
  }
  return null;
}
