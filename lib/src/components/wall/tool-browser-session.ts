import type { PlatformAdapter } from '../../lib/platform/types';
/** The host capabilities this module needs — the same two the CLI path leans
 *  on, narrowed so tests can stub them without a full adapter. */
type ConnectPlatform = Pick<PlatformAdapter, 'agentBrowserCommand' | 'agentBrowserAttach'>;

/**
 * Open `url` in `session` and hand `surfaceId` the resulting `{session, wsPort}`
 * as one params write for the tool serving trigger.
 *
 * The surface gets its `session` whether or not the open succeeded, so a failed
 * pane's placeholder names the session instead of sitting session-less.
 */
export async function attachAgentBrowserSession({
  url,
  platform,
  session,
  surfaceId,
  binaryPath,
  refreshSurface,
}: {
  url: string;
  platform: ConnectPlatform;
  session: string;
  surfaceId: string;
  binaryPath?: string;
  refreshSurface: (surfaceId: string, patch: Record<string, unknown>) => void;
}): Promise<void> {
  if (!platform.agentBrowserCommand) return;
  // The CLI boots the daemon/browser if it isn't already running.
  const opened = await platform.agentBrowserCommand(session, ['open', url], binaryPath);
  if (opened.exitCode !== 0) {
    refreshSurface(surfaceId, { session });
    return;
  }
  // Best-effort stream port so the panel connects straight to the live screencast;
  // if it's absent or stale the panel recovers it later, so a miss is non-fatal.
  let wsPort: number | undefined;
  if (platform.agentBrowserAttach) {
    const status = await platform.agentBrowserAttach(session, {}, binaryPath);
    if (status.ok) wsPort = status.wsPort;
  }
  // Setting `session` connects the controller (the daemon is up now, so its
  // recovery is safe to run).
  refreshSurface(surfaceId, {
    session,
    ...(wsPort !== undefined ? { wsPort } : {}),
  });
}
