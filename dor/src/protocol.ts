/**
 * The dor control protocol's wire contract — shared by the CLI, the control
 * servers that bridge it into each host, and the webview that fulfils control
 * requests. This is the single source of truth for the transport envelope;
 * method-specific request/response shapes live in `commands/types.ts`. As the
 * protocol grows, add to these types here rather than re-declaring them per
 * layer.
 */

/**
 * The wire identifier for each surface control operation. Single source of truth
 * shared by the CLI client (which emits them) and the webview handler (which
 * dispatches on them) — reference these instead of bare `'surface.*'` literals so
 * the two sides can't drift and a typo is a compile error, not a silent no-op.
 */
export const SURFACE_CONTROL_METHODS = {
  list: 'surface.list',
  split: 'surface.split',
  ensure: 'surface.ensure',
  tool: 'surface.tool',
  send: 'surface.send',
  read: 'surface.read',
  await: 'surface.await',
  kill: 'surface.kill',
  iframe: 'surface.iframe',
  agentBrowser: 'surface.agentBrowser',
  resolveOpen: 'surface.resolveOpen',
  resolveAgentBrowser: 'surface.resolveAgentBrowser',
} as const;

export type SurfaceControlMethod = (typeof SURFACE_CONTROL_METHODS)[keyof typeof SURFACE_CONTROL_METHODS];

/** A control request as it travels over a transport, correlated by `requestId`. */
export interface DorControlRequestPayload {
  requestId: string;
  surfaceId?: string;
  method: string;
  params?: Record<string, unknown>;
  /**
   * The client's own deadline for this request, in milliseconds. A hint, not an
   * instruction: the control server uses it to set a timer that deliberately
   * *outlasts* the client's, so the client is always the side that decides the
   * outcome. Absent (or nonsense) means "use the server's default".
   */
  timeoutMs?: number;
}

/**
 * Sent server → webview when a request will never be answered: the `dor` client
 * disconnected (timeout / Ctrl-C), or the server's own deadline fired. The
 * webview aborts the request's `AbortSignal` so a long-running handler can
 * release whatever it armed. Travels as the `dor:controlCancel` event, the
 * cancellation counterpart of `dor:controlRequest` / `dor:controlResponse`.
 */
export interface DorControlCancelPayload {
  requestId: string;
}

/** The result envelope returned for a control request. `result` is method-specific. */
export interface DorControlResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}

/** A control result correlated back to its request over a transport. */
export interface DorControlResponsePayload<T = unknown> extends DorControlResult<T> {
  requestId: string;
}
