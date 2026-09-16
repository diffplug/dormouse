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

function writeBoolFlag(key: string, enabled: boolean): void {
  try {
    if (enabled) globalThis.localStorage?.setItem(key, 'true');
    else globalThis.localStorage?.removeItem(key);
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

/** Toggle Dor Tools from Settings, dev tooling, or Storybook. */
export function setToolsEnabled(enabled: boolean): void {
  writeBoolFlag(TOOLS_FLAG_KEY, enabled);
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
