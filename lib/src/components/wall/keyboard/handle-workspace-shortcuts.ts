import { activateWorkspaceAt, createWorkspace, getActiveWorkspaceId } from '../../../lib/workspace-store';
import { activateWorkspaceTab, enterWorkspace, requestWorkspaceRename } from '../workspace-lifecycle';
import type { WallKeyboardCtx } from './types';

/** Command-mode Workspace navigation and rename. Bare Walls leave these keys unbound. */
export function handleWorkspaceShortcuts(e: KeyboardEvent, ctx: WallKeyboardCtx): boolean {
  if (ctx.workspaceId === undefined) return false;
  // Bare keys only: a modified key is a clipboard or host chord.
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key === ',' && ctx.selectedTypeRef.current === 'workspace') {
    e.preventDefault();
    e.stopPropagation();
    const id = ctx.selectedIdRef.current;
    if (id) requestWorkspaceRename(id);
    return true;
  }
  if (e.key === 'Enter') {
    const kind = ctx.selectedTypeRef.current;
    if (kind === 'workspace' || kind === 'workspace-new') {
      e.preventDefault();
      e.stopPropagation();
      if (kind === 'workspace-new') void enterWorkspace(createWorkspace().id);
      else {
        const id = ctx.selectedIdRef.current;
        if (id === getActiveWorkspaceId()) void enterWorkspace(id);
        else if (id) void activateWorkspaceTab(id);
      }
      return true;
    }
  }
  if (!/^[1-9]$/.test(e.key)) return false;

  e.preventDefault();
  e.stopPropagation();
  activateWorkspaceAt(Number(e.key) - 1);
  return true;
}
