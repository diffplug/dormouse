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

export const LATH_FLAG_KEY = 'dormouse.flags.lath';

/** Whether the Wall renders and mutates through the in-house Lath tiling engine
 *  instead of dockview-react (docs/specs/tiling-engine.md → lath-rollout stage 2).
 *  Off by default. Read ONCE per Wall mount (via a lazy `useRef` initializer), so
 *  toggling requires a reload — the same contract as `abDebugLogs`. While the flag
 *  lives (stages 2–4) saves dual-write both layout formats, so flipping it either
 *  direction never loses a layout. */
export function isLathEnabled(): boolean {
  return readBoolFlag(LATH_FLAG_KEY);
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
