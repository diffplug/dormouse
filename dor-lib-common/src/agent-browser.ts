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
