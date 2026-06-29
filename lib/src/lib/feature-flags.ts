/**
 * Runtime feature flags, toggled via `localStorage` so they work uniformly
 * across standalone, the VS Code webview, the website, Storybook, and tests.
 *
 * The **workspaces** flag gates the Workspace/Window container (stage 2b) and
 * everything built on it — the switching UI (stage 3) and real multi-Workspace
 * support (stage 4). It is **off by default**: with the flag off, the app
 * persists and restores a single bare `PersistedSession` exactly as before, so
 * the container code is dormant. See `docs/specs/glossary.md` → Implementation
 * status.
 */

export const WORKSPACES_FLAG_KEY = 'dormouse.flags.workspaces';

function readBoolFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === 'true';
  } catch {
    // No localStorage (some host/test contexts): treat as disabled.
    return false;
  }
}

/** Whether the Workspace/Window container is enabled. Off by default (dormant). */
export function isWorkspacesEnabled(): boolean {
  return readBoolFlag(WORKSPACES_FLAG_KEY);
}

/** Toggle the workspaces flag (used by dev tooling / the stage-3 Storybook UI). */
export function setWorkspacesEnabled(enabled: boolean): void {
  try {
    if (enabled) globalThis.localStorage?.setItem(WORKSPACES_FLAG_KEY, 'true');
    else globalThis.localStorage?.removeItem(WORKSPACES_FLAG_KEY);
  } catch {
    // No localStorage: nothing to persist.
  }
}
