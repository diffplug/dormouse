import {
  activateAdjacentWorkspace,
  activateWorkspaceAt,
  createWorkspace,
  getActiveWorkspaceId,
} from '../../../lib/workspace-store';
import { activateWorkspaceTab, enterWorkspace, requestWorkspaceClose, requestWorkspaceRename } from '../workspace-lifecycle';
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

  // Enter on a tab mirrors a click: an inactive tab activates in command mode,
  // the active one renames. `+` creates and enters the new pane.
  if (e.key === 'Enter') {
    const kind = ctx.selectedTypeRef.current;
    if (kind === 'workspace-new') return run(() => { void enterWorkspace(createWorkspace().id); });
    if (kind === 'workspace') {
      return run(() => {
        const id = ctx.selectedIdRef.current;
        if (!id) return;
        if (id === getActiveWorkspaceId()) requestWorkspaceRename(id);
        else void activateWorkspaceTab(id);
      });
    }
  }

  if (e.key === 'x' && ctx.selectedTypeRef.current === 'workspace') {
    return run(() => {
      const id = ctx.selectedIdRef.current;
      if (id) requestWorkspaceClose(id, { forceConfirm: true });
    });
  }

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
