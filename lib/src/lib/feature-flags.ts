/**
 * Runtime feature flags, toggled via `localStorage` so they work uniformly
 * across standalone, the VS Code webview, the website, Storybook, and tests.
 */

function readBoolFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === 'true';
  } catch {
    // No localStorage (some host/test contexts): treat as disabled.
    return false;
  }
}

/** A positive number stored under `key`, or null. */
function readPositiveNumberFlag(key: string): number | null {
  try {
    const value = Number(globalThis.localStorage?.getItem(key) ?? NaN);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Overrides the Tool reap idle threshold, in ms: testing only
 *  (`docs/specs/dor-tool.md` -> Reaping). */
export const TOOL_REAP_IDLE_MS_FLAG_KEY = 'dormouse.debug.toolReapIdleMs';

export function toolReapIdleMsOverride(): number | null {
  return readPositiveNumberFlag(TOOL_REAP_IDLE_MS_FLAG_KEY);
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
