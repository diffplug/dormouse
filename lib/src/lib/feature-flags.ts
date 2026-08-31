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

export const TOOLS_FLAG_KEY = 'dormouse.flags.tools';

/** Whether Dor Tools are enabled (`docs/specs/dor-tool.md`). Off by default:
 *  with the flag off, `dor tool` reports that tools are disabled and no
 *  Session is ever designated, so the serving trigger has nothing to watch and
 *  no pane can transform. */
export function isToolsEnabled(): boolean {
  return readBoolFlag(TOOLS_FLAG_KEY);
}

/** Toggle the tools flag (dev tooling / Storybook). */
export function setToolsEnabled(enabled: boolean): void {
  try {
    if (enabled) globalThis.localStorage?.setItem(TOOLS_FLAG_KEY, 'true');
    else globalThis.localStorage?.removeItem(TOOLS_FLAG_KEY);
  } catch {
    // No localStorage: nothing to persist.
  }
}

export const AB_DEBUG_LOGS_FLAG_KEY = 'dormouse.flags.abDebugLogs';

/** Whether the agent-browser high-rate `[ab-panel]`/`[agent-browser]` stream and
 *  screenshot console diagnostics are emitted. Off by default: they fire per
 *  frame (~20Hz) and are only useful when actively debugging. Read once at module
 *  load by hot-loop callers, so toggling needs a reload. The connection's
 *  always-on debug ring (`debugSnapshot()`) is unaffected. */
export function isAbDebugLogsEnabled(): boolean {
  return readBoolFlag(AB_DEBUG_LOGS_FLAG_KEY);
}
