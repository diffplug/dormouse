import type { PlatformAdapter } from './types';
import { VSCodeAdapter } from './vscode-adapter';
import { FakePtyAdapter } from './fake-adapter';

export type { PlatformAdapter } from './types';
export type { PtyInfo } from './types';
export { FakePtyAdapter } from './fake-adapter';
export type { FakeScenario } from './fake-adapter';
export {
  flattenScenario,
  makeAlertScenario,
  SCENARIO_SHELL_PROMPT,
  SCENARIO_LS_OUTPUT,
  SCENARIO_ANSI_COLORS,
  SCENARIO_LONG_RUNNING,
  SCENARIO_FAST_OUTPUT,
} from './fake-scenarios';

/**
 * Best available platform identifier from the browser. Prefers the
 * UA-Client-Hints `userAgentData.platform` (e.g. "macOS", "Windows"),
 * falling back to the legacy `navigator.platform`, then `userAgent`.
 * Empty string in non-browser environments. Computed once at module load.
 */
export const PLATFORM_STRING: string = (() => {
  if (typeof navigator === 'undefined') return '';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? '';
})();

/**
 * True when running on macOS. Used to pick native keyboard conventions
 * (Cmd vs Ctrl for copy/paste, etc.).
 */
export const IS_MAC: boolean = /Mac|iPhone|iPad/i.test(PLATFORM_STRING);

let adapter: PlatformAdapter | null = null;

/** Set an externally-created platform adapter (e.g. TauriAdapter from standalone). */
export function setPlatform(a: PlatformAdapter): void {
  adapter = a;
}

export function getPlatform(): PlatformAdapter {
  if (!adapter) throw new Error('Platform not initialized — call initPlatform() or setPlatform() first');
  return adapter;
}

export function initPlatform(override: 'fake'): FakePtyAdapter;
export function initPlatform(): PlatformAdapter;
export function initPlatform(override?: 'fake'): PlatformAdapter {
  if (adapter) return adapter as PlatformAdapter;
  if (override === 'fake') {
    adapter = new FakePtyAdapter();
    return adapter;
  }
  if (typeof acquireVsCodeApi === 'function') {
    adapter = new VSCodeAdapter();
  } else {
    adapter = new FakePtyAdapter();
  }
  return adapter;
}
