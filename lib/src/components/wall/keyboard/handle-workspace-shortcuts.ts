import {
  activateAdjacentWorkspace,
  activateWorkspaceAt,
  createWorkspace,
  getActiveWorkspaceId,
} from '../../../lib/workspace-store';
import { requestWorkspaceClose, requestWorkspaceRename } from '../workspace-lifecycle';
import type { WallKeyboardCtx } from './types';

/**
 * Command-mode Workspace shortcuts, following tmux's window bindings (tmux's
 * `,` is already pane rename here, so rename is `$`). The binding table is
 * `docs/specs/shortcuts.md`; the behavior is `docs/specs/layout.md` →
 * "Workspaces".
 *
 * Every key is inert on a Wall with no `workspaceId`, which is what keeps a bare
 * Wall — VS Code, the website playground — unbound.
 */
export function handleWorkspaceShortcuts(e: KeyboardEvent, ctx: WallKeyboardCtx): boolean {
  if (ctx.workspaceId === undefined) return false;
  // Bare keys only: a modified `c` is a clipboard or host chord, never create.
  if (e.metaKey || e.ctrlKey || e.altKey) return false;

  const run = (action: () => void): true => {
    e.preventDefault();
    e.stopPropagation();
    action();
    return true;
  };

  // Targets resolve through the ACTIVE Workspace, never the Wall that heard the
  // key, so a stale keystroke from a hidden one could not act on the wrong one.
  if (e.key === 'c') return run(() => { createWorkspace(); });
  if (e.key === 'n') return run(() => activateAdjacentWorkspace(1));
  if (e.key === 'p') return run(() => activateAdjacentWorkspace(-1));
  if (e.key === '&') return run(() => requestWorkspaceClose(getActiveWorkspaceId()));
  if (e.key === '$') return run(() => requestWorkspaceRename(getActiveWorkspaceId()));
  if (e.key >= '1' && e.key <= '9') return run(() => activateWorkspaceAt(Number(e.key) - 1));
  return false;
}
