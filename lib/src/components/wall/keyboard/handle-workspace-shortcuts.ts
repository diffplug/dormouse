import type { WallKeyboardCtx } from './types';

/**
 * Command-mode Workspace shortcuts, following tmux's window bindings (tmux's
 * `,` is already pane rename here, so rename is `$`). The binding table is
 * `docs/specs/shortcuts.md`; the behavior is `docs/specs/layout.md` →
 * "Workspaces".
 *
 * Every key is inert without `ctx.workspaces`, which is what keeps a bare Wall —
 * VS Code, the website playground — unbound.
 */
export function handleWorkspaceShortcuts(e: KeyboardEvent, ctx: WallKeyboardCtx): boolean {
  const workspaces = ctx.workspaces;
  if (!workspaces) return false;
  // Bare keys only: a modified `c` is a clipboard or host chord, never create.
  if (e.metaKey || e.ctrlKey || e.altKey) return false;

  const run = (action: () => void): true => {
    e.preventDefault();
    e.stopPropagation();
    action();
    return true;
  };

  if (e.key === 'c') return run(() => workspaces.create());
  if (e.key === 'n') return run(() => workspaces.cycle(1));
  if (e.key === 'p') return run(() => workspaces.cycle(-1));
  if (e.key === '&') return run(() => workspaces.requestClose());
  if (e.key === '$') return run(() => workspaces.requestRename());
  if (e.key >= '1' && e.key <= '9') return run(() => workspaces.selectIndex(Number(e.key) - 1));
  return false;
}
