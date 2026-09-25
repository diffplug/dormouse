/**
 * Extension-host wiring for browser automation
 * (docs/specs/dor-browser.md → "Browser Host").
 *
 * The host itself is host-agnostic and lives in `lib/src/host/browser-host.ts`
 * (shared verbatim with the standalone Node sidecar), viewer sockets included;
 * this file only instantiates it with the VS-Code-specific bits — writing the
 * OS clipboard, and logging.
 */
import * as vscode from 'vscode';
import { log } from './log';
import { createAgentBrowserProvider } from '../../lib/src/host/agent-browser-host';
import { createBrowserHost } from '../../lib/src/host/browser-host';
import { createPlaywrightProvider } from '../../lib/src/host/playwright-host';

const logInfo = (message: string) => log.info(message);
const host = createBrowserHost({
  // Awaited rather than returned: `vscode.env.clipboard.writeText` yields a
  // `Thenable`, VS Code's minimal promise interface, which is not a `Promise`.
  writeClipboardText: async (text) => { await vscode.env.clipboard.writeText(text); },
  log: logInfo,
  providers: {
    'agent-browser': () => createAgentBrowserProvider({ log: logInfo }),
    playwright: () => createPlaywrightProvider({ log: logInfo }),
  },
});

export const runBrowserRequest = host.request;

// Every provider's cleanup shares one deadline, as in the standalone sidecar's
// shutdown: the Playwright host first waits out in-flight launches and connects,
// and `deactivate` joins this ahead of the session flush,
// which VS Code's unknown kill budget must still reach.
const CLOSE_DEADLINE_MS = 1500;

export async function closeBrowserSessions(): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    host.close(),
    new Promise<void>((resolve) => { deadline = setTimeout(resolve, CLOSE_DEADLINE_MS); }),
  ]).finally(() => clearTimeout(deadline));
}
