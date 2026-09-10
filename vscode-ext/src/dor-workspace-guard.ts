/**
 * VS Code maps each Workspace to a webview of its own (`docs/specs/vscode.md` →
 * Workspaces), so this host has no Window-wide Workspace model to answer with:
 * a Workspace-spanning `dor` request would report one webview's Workspace as if
 * it were all of them, and a mutation would move a strip that does not exist.
 * This host serves exactly the one Workspace each webview is — positional 1 —
 * and refuses everything that spans, at the extension host, before the request
 * reaches a webview.
 */

import { parseWorkspaceRef, spansWorkspaces } from 'dor/protocol';

const REFUSAL = 'Dormouse in VS Code puts each Workspace in its own webview, so';

/**
 * Why this request cannot be answered here, or null to let it through. Reads
 * only the wire request, so it holds for every transport that reaches the
 * extension host.
 */
export function dorWorkspaceRefusal(method: string, params: Record<string, unknown> | undefined): string | null {
  const workspace = params?.workspace;
  if (workspace !== undefined) {
    const named = typeof workspace === 'string' ? parseWorkspaceRef(workspace).position : null;
    if (named !== 1) return `${REFUSAL} it has no workspace '${String(workspace)}' to act on`;
  }
  if (spansWorkspaces(method, params)) {
    return `${REFUSAL} dor workspace, dor list --workspaces and dor list --all are not available here`;
  }
  return null;
}
