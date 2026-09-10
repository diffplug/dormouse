import type { WorkspaceId } from './session-types';

/**
 * The one-way bridge from a Wall's keyboard to the strip: `&` and `$` in command
 * mode open the strip's close confirmation and rename editor, which live in the
 * AppBar, outside every Wall (`docs/specs/layout.md` → "Workspaces"). Nothing
 * listening simply drops the intent.
 */
export type WorkspaceStripIntent =
  | { kind: 'close'; workspaceId: WorkspaceId }
  | { kind: 'rename'; workspaceId: WorkspaceId };

const listeners = new Set<(intent: WorkspaceStripIntent) => void>();

export function requestWorkspaceStripIntent(intent: WorkspaceStripIntent): void {
  listeners.forEach((listener) => listener(intent));
}

export function subscribeToWorkspaceStripIntent(
  listener: (intent: WorkspaceStripIntent) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
