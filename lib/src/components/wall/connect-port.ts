/**
 * "Connect a port" — the wall-side reproduction of `dor ab open <url>` for the
 * pane context menu (see `dor/src/commands/agent-browser.ts` for the CLI flow).
 * Opens the URL in the workspace's default agent-browser session and reuses or
 * creates that session's browser surface. Dependency-injected (platform +
 * `ensureSurface`) so it stays unit-testable off the React tree.
 */
import type { PlatformAdapter } from '../../lib/platform/types';
import type { Surface as DorSurface } from 'dor/commands/types';
// The browser-safe subpath: dist/agent-browser.js is pure ES, so importing it
// keeps cross-spawn (the package's Node-only default export) out of the webview.
import { sessionForKey } from 'dor-lib-common/agent-browser';
import type { EnsureAgentBrowserSurface } from './use-dor-control';

/** The host capabilities `connectPortToDefaultBrowser` needs — the same two the
 *  CLI path leans on, narrowed so tests can stub them without a full adapter. */
type ConnectPlatform = Pick<PlatformAdapter, 'agentBrowserCommand' | 'agentBrowserStreamStatus'>;

export type ConnectPortResult = { ok: true } | { ok: false; message: string };

export async function connectPortToDefaultBrowser({
  url,
  reference,
  platform,
  binaryPath,
  ensureSurface,
}: {
  url: string;
  /** The pane the port belongs to — the split reference for a fresh surface. */
  reference: DorSurface;
  platform: ConnectPlatform;
  /** Last binary path a `dor ab` surface resolved; undefined ⇒ host falls back
   *  to PATH / DORMOUSE_AGENT_BROWSER_BIN. */
  binaryPath?: string;
  ensureSurface: EnsureAgentBrowserSurface;
}): Promise<ConnectPortResult> {
  const session = sessionForKey('default');
  // Host-gated: no agent-browser runner ⇒ no browser surface (same spirit as the
  // render-swap guard in Wall.tsx).
  if (!platform.agentBrowserCommand) {
    return { ok: false, message: 'opening a browser surface is not supported on this host' };
  }
  // 'open' is on the host's subcommand allowlist; the CLI boots the daemon/browser
  // if it isn't already running.
  const opened = await platform.agentBrowserCommand(session, ['open', url], binaryPath);
  if (opened.exitCode !== 0) {
    return { ok: false, message: opened.stderr.trim() || `agent-browser open exited ${opened.exitCode}` };
  }
  // Best-effort stream port so the panel connects straight to the live screencast;
  // if it's absent or stale the panel recovers it later, so a miss is non-fatal.
  let wsPort: number | undefined;
  if (platform.agentBrowserStreamStatus) {
    const status = await platform.agentBrowserStreamStatus(session, binaryPath);
    if (status.ok) wsPort = status.wsPort;
  }
  // The menu resolved its pane eagerly (it's the visible pane under the cursor),
  // so the lazy reference just hands it through.
  const ensured = ensureSurface({ key: 'default', session, wsPort, binaryPath, reference: () => ({ ok: true, value: reference }) });
  if (!ensured.ok) return { ok: false, message: ensured.message };
  return { ok: true };
}
