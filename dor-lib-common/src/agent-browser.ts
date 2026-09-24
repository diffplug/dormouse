// The scope a Window with one implicit Workspace answers with: a bare Wall (VS
// Code, the website, Pocket) has no Workspace id of its own, so its keys keep
// the names they have always had. Private: callers build session names through
// sessionForKey, never by hand.
const BARE_WALL_SCOPE = '1';

// A session name becomes a filesystem path (the daemon's socket dir), so both
// halves are held to the charset `dor ab --key` enforces CLI-side: the key
// arrives over the control socket too, from clients that are not `dor`.
const UNSAFE_SESSION_CHARS = /[^A-Za-z0-9._-]/g;

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
 * Managed, workspace-scoped agent-browser session name:
 * `dormouse.<workspaceId>.<key>`, and `dormouse.1.<key>` for a Window whose one
 * Wall has no Workspace id (`workspaceId` omitted). The scope is what keeps one
 * `--key default` per Workspace from being one shared browser
 * (`docs/specs/dor-browser.md` → Managed identity).
 *
 * agent-browser session names become filesystem paths (the socket dir), so `/`
 * can't separate the namespace — the daemon fails to start; dots keep it
 * readable. Shared by `dor ab` (--key resolution) and the lib host (GUI sessions).
 */
export function sessionForKey(key: string, workspaceId?: string): string {
  const scope = workspaceId ? workspaceId.replace(UNSAFE_SESSION_CHARS, '-') : BARE_WALL_SCOPE;
  return `dormouse.${scope}.${key.replace(UNSAFE_SESSION_CHARS, '-')}`;
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
