/** Workspace id baked into managed agent-browser session names. Hardcoded until
 * Dormouse exposes real workspaces; encoded now to avoid a later rename. */
export const AGENT_BROWSER_WORKSPACE_ID = '1';

/** Env var that overrides which agent-browser binary to run; shared so `dor ab`
 * and the host key off the same name. */
export const AGENT_BROWSER_BIN_ENV = 'DORMOUSE_AGENT_BROWSER_BIN';

/** Default binary name, resolved on PATH when no override/explicit path is given. */
export const DEFAULT_AGENT_BROWSER_BIN = 'agent-browser';

/** argv for `agent-browser stream status --json` against a session — the command
 * whose output {@link parseStreamPort} reads. */
export function streamStatusArgs(session: string): string[] {
  return ['--session', session, 'stream', 'status', '--json'];
}

/**
 * Managed, workspace-scoped agent-browser session name: `dormouse.<workspaceId>.<key>`.
 * agent-browser session names become filesystem paths (the socket dir), so `/`
 * can't separate the namespace — the daemon fails to start; dots keep it
 * readable. Shared by `dor ab` (--key resolution) and the lib host (GUI sessions).
 */
export function sessionForKey(key: string): string {
  return `dormouse.${AGENT_BROWSER_WORKSPACE_ID}.${key}`;
}

/**
 * Parse the stream WebSocket port from `agent-browser stream status --json`.
 * The CLI wraps payloads as either `{ port }` or `{ data: { port } }`; tolerate
 * both, and return undefined for anything malformed or non-finite. Shared by
 * `dor ab` (surface binding) and the lib host (panel stream recovery).
 */
export function parseStreamPort(stdout: string): number | undefined {
  try {
    const parsed = JSON.parse(stdout) as { port?: unknown; data?: { port?: unknown } };
    const port = parsed.data?.port ?? parsed.port;
    return typeof port === 'number' && Number.isFinite(port) ? port : undefined;
  } catch {
    return undefined;
  }
}
