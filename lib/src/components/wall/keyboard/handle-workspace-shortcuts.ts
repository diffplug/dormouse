import { activateWorkspaceAt } from '../../../lib/workspace-store';
import type { WallKeyboardCtx } from './types';

/** Command-mode Workspace switching. A bare Wall leaves these keys unbound. */
export function handleWorkspaceShortcuts(e: KeyboardEvent, ctx: WallKeyboardCtx): boolean {
  if (ctx.workspaceId === undefined) return false;
  // Bare keys only: a modified key is a clipboard or host chord.
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key < '1' || e.key > '9' || e.key.length !== 1) return false;

  e.preventDefault();
  e.stopPropagation();
  activateWorkspaceAt(Number(e.key) - 1);
  return true;
}
