/**
 * The dor control protocol's wire contract — shared by the CLI, the control
 * servers that bridge it into each host, and the webview that fulfils control
 * requests. This is the single source of truth for the transport envelope;
 * method-specific request/response shapes live in `commands/types.ts`. As the
 * protocol grows, add to these types here rather than re-declaring them per
 * layer.
 */

/** A control request as it travels over a transport, correlated by `requestId`. */
export interface DorControlRequestPayload {
  requestId: string;
  surfaceId?: string;
  method: string;
  params?: Record<string, unknown>;
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
