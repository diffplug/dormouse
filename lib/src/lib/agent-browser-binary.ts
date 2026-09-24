/**
 * What may be spawned as a browser provider's CLI (docs/specs/dor-browser.md →
 * "Agent-Browser Host Capabilities"). The predicates live in `dor-lib-common`,
 * whose comment explains why `binaryPath` is an exec channel, so `dor` applies
 * the same gate to a binding the host hands back; re-exported here for the
 * webview and the Node hosts.
 */

import {
  BROWSER_PROVIDERS,
  isAllowedAgentBrowserBinary,
  isAllowedPlaywrightBinary,
  type BrowserAutomationProvider,
} from 'dor-lib-common/browser-providers';

export { isAllowedAgentBrowserBinary, isAllowedPlaywrightBinary };

/** The webview's gate for whichever provider will spawn `candidate`. */
export function isAllowedBinaryFor(provider: BrowserAutomationProvider, candidate: unknown): candidate is string {
  return BROWSER_PROVIDERS[provider].isAllowedBinary(candidate);
}
