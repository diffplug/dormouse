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

export const AB_DEBUG_LOGS_FLAG_KEY = 'dormouse.flags.abDebugLogs';

/** Whether the agent-browser high-rate `[ab-panel]`/`[agent-browser]` stream and
 *  screenshot console diagnostics are emitted. Off by default: they fire per
 *  frame (~20Hz) and are only useful when actively debugging. Read once at module
 *  load by hot-loop callers, so toggling needs a reload. The connection's
 *  always-on debug ring (`debugSnapshot()`) is unaffected. */
export function isAbDebugLogsEnabled(): boolean {
  return readBoolFlag(AB_DEBUG_LOGS_FLAG_KEY);
}
