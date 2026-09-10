/**
 * VS Code maps each Workspace to a webview of its own (`docs/specs/vscode.md` →
 * Workspaces), so this host has no Window-wide Workspace model to answer with:
 * a Workspace-spanning `dor` request would report one webview's Workspace as if
 * it were all of them, and a mutation would move a strip that does not exist.
 * Every such request is refused here, at the extension host, before it reaches a
 * webview.
 */

import { SURFACE_CONTROL_METHODS, WORKSPACE_CONTROL_METHODS } from 'dor/protocol';

/** The one Workspace a VS Code webview has, in both accepted spellings. */
const THIS_WORKSPACE = new Set(['workspace:1', '1']);

const REFUSAL = 'Dormouse in VS Code puts each Workspace in its own webview, so';

/**
 * Why this request cannot be answered here, or null to let it through. Reads
 * only the wire request, so it holds for every transport that reaches the
 * extension host.
 */
export function dorWorkspaceRefusal(method: string, params: Record<string, unknown> | undefined): string | null {
  const workspace = params?.workspace;
  if (workspace !== undefined && !(typeof workspace === 'string' && THIS_WORKSPACE.has(workspace.trim()))) {
    return `${REFUSAL} it has no workspace '${String(workspace)}' to act on`;
  }
  if (method === SURFACE_CONTROL_METHODS.list && params?.scope === 'all') {
    return `${REFUSAL} dor list --all would list only this one`;
  }
  if ((Object.values(WORKSPACE_CONTROL_METHODS) as string[]).includes(method)) {
    return `${REFUSAL} dor workspace and dor list --workspaces are not available here`;
  }
  return null;
}
