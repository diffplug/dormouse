/**
 * "Connect a port" — the wall-side reproduction of `dor ab open <url>` for the
 * pane context menu (see `dor/src/commands/agent-browser.ts` for the CLI flow).
 * Opens the URL in the workspace's default agent-browser session and reuses or
 * creates that session's browser surface. Dependency-injected (platform +
 * eager-surface/refresh seams) so it stays unit-testable off the React tree.
 *
 * Sequencing (`docs/specs/dor-browser.md` → Pane Context Menu Connect): the pane
 * is created SYNCHRONOUSLY and WITHOUT a `session`, so it appears the instant the
 * port is clicked and the controller's stale-port recovery stays inert until the
 * daemon is up (a session-less agent-browser pane spawns no CLI). The background
 * `open` + `stream status` then deliver `{session, wsPort, binaryPath}` as one
 * params refresh.
 */
import type { PlatformAdapter } from '../../lib/platform/types';
import type { ParseResult } from 'dor/commands/types';
// The browser-safe subpath: dist/agent-browser.js is pure ES, so importing it
// keeps cross-spawn (the package's Node-only default export) out of the webview.
import { sessionForKey } from 'dor-lib-common/agent-browser';

/** The host capabilities `connectPortToDefaultBrowser` needs — the same two the
 *  CLI path leans on, narrowed so tests can stub them without a full adapter. */
type ConnectPlatform = Pick<PlatformAdapter, 'agentBrowserCommand' | 'agentBrowserStreamStatus'>;

export type ConnectPortResult = { ok: true } | { ok: false; message: string };

export async function connectPortToDefaultBrowser({
  url,
  platform,
  binaryPath,
  ensureEagerSurface,
  refreshSurface,
}: {
  url: string;
  platform: ConnectPlatform;
  /** Last binary path a `dor ab` surface resolved; undefined ⇒ host falls back
   *  to PATH / DORMOUSE_AGENT_BROWSER_BIN. */
  binaryPath?: string;
  /** Reuse-or-create the default browser pane synchronously, before the daemon
   *  boots, so the pane is on screen the instant the port is clicked. Created
   *  session-less on purpose (see file header). */
  ensureEagerSurface: (session: string) => ParseResult<{ surfaceId: string }>;
  /** Fold a params patch onto the eager surface (visible pane or minimized door)
   *  — used to hand the pane its `session` and refreshed stream port. */
  refreshSurface: (surfaceId: string, patch: Record<string, unknown>) => void;
}): Promise<ConnectPortResult> {
  // Host-gated: no agent-browser runner ⇒ no browser surface (same spirit as the
  // render-swap guard in Wall.tsx). Short-circuit before touching the layout.
  if (!platform.agentBrowserCommand) {
    return { ok: false, message: 'opening a browser surface is not supported on this host' };
  }
  const session = sessionForKey('default');
  // Pane appears NOW, session-less — the controller can't race the daemon boot.
  const eager = ensureEagerSurface(session);
  if (!eager.ok) return { ok: false, message: eager.message };

  // 'open' is on the host's subcommand allowlist; the CLI boots the daemon/browser
  // if it isn't already running.
  const opened = await platform.agentBrowserCommand(session, ['open', url], binaryPath);
  if (opened.exitCode !== 0) {
    // The pane stays; hand it the session so its placeholder names the session
    // instead of sitting sessionless.
    refreshSurface(eager.value.surfaceId, { session });
    return { ok: false, message: opened.stderr.trim() || `agent-browser open exited ${opened.exitCode}` };
  }
  // Best-effort stream port so the panel connects straight to the live screencast;
  // if it's absent or stale the panel recovers it later, so a miss is non-fatal.
  let wsPort: number | undefined;
  if (platform.agentBrowserStreamStatus) {
    const status = await platform.agentBrowserStreamStatus(session, binaryPath);
    if (status.ok) wsPort = status.wsPort;
  }
  // One params write reconciles the session-less pane: setting `session` connects
  // the controller (the daemon is up now, so its recovery is safe to run).
  refreshSurface(eager.value.surfaceId, {
    session,
    ...(wsPort !== undefined ? { wsPort } : {}),
    ...(binaryPath !== undefined ? { binaryPath } : {}),
  });
  return { ok: true };
}
