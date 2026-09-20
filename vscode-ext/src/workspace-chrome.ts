import * as vscode from 'vscode';
import type { WorkspaceUnion } from '../../lib/src/lib/workspace-union';

const BASE_TITLE = 'Dormouse';

/** A Workspace's union status as a native chrome title suffix, the plain-text
 *  stand-in for what the Wall draws (`docs/specs/vscode.md`). */
export function workspaceTitle(union: WorkspaceUnion): string {
  let title = BASE_TITLE;
  if (union.ringing) title += ' 🔔';
  if (union.todo) title += ' [TODO]';
  return title;
}

/**
 * Presence badge for a panel/sidebar `WebviewView`. On a single-view panel
 * container VS Code shows the static container title, so `view.title` can't
 * carry status (see docs/specs/vscode.md) — the badge is the only runtime
 * indicator that surfaces there. It's a presence flag, not a count: value `1`
 * whenever anything owes attention (ringing or TODO), `0` to clear it.
 *
 * `0` (not `undefined`) is the clear value on purpose: VS Code hides a 0-value
 * badge but does NOT clear one set to `undefined` on a bottom-panel container.
 * The ring-vs-TODO detail lives in the tooltip.
 */
export function workspaceBadge(union: WorkspaceUnion): vscode.ViewBadge {
  const parts: string[] = [];
  if (union.ringing) parts.push('Ringing');
  if (union.todo) parts.push('TODO');
  return { value: parts.length > 0 ? 1 : 0, tooltip: parts.join(' · ') };
}
