import type { DorControlRequestPayload, DorControlResult } from 'dor/protocol';

/**
 * The webview end of the `dor` control transport, shared by every adapter that
 * receives control requests (Tauri, the browser sidecar, VS Code). Each host
 * carries the same three events over its own wire — `dor:controlRequest`,
 * `dor:controlResponse`, `dor:controlCancel` — and needs the same bookkeeping on
 * this side, so it lives here once instead of three times.
 *
 * A control request can outlive the client that made it: a parked `dor await`
 * blocks for minutes, and its client can time out or be Ctrl-C'd at any point.
 * The control server sends `dor:controlCancel` when that happens (or when its
 * own deadline fires), and the handler learns about it through the request's
 * `AbortSignal` — its cue to release whatever it armed, since nothing it
 * responds with can reach the client any more.
 *
 * Source of truth for the wire shapes: `dor/src/protocol.ts`.
 */

/** In-flight requests, keyed by `requestId`. Module-global because a webview
 *  runs exactly one adapter, and the transport is a process-wide singleton. */
const inFlight = new Map<string, AbortController>();

/**
 * Turn a wire request into the `dormouse:control-request` CustomEvent that
 * `use-dor-control.ts` handles, with a signal the matching cancel can fire.
 * `respond` is the adapter's transport-specific reply path; the wrapper handed
 * to the handler clears the bookkeeping first, so answering a request is also
 * what forgets it.
 */
export function dispatchDorControlRequest(
  payload: DorControlRequestPayload,
  respond: (response: DorControlResult) => void,
): void {
  const { requestId } = payload;
  const controller = new AbortController();
  inFlight.set(requestId, controller);

  window.dispatchEvent(new CustomEvent('dormouse:control-request', {
    detail: {
      requestId,
      surfaceId: payload.surfaceId,
      method: payload.method,
      params: payload.params ?? {},
      signal: controller.signal,
      respond: (response: DorControlResult) => {
        inFlight.delete(requestId);
        respond(response);
      },
    },
  }));
}

/** Abort the request's signal, if it is still in flight. Unknown ids are a
 *  no-op: the handler already responded and the cancel merely lost the race. */
export function cancelDorControlRequest(requestId: string): void {
  const controller = inFlight.get(requestId);
  if (!controller) return;
  inFlight.delete(requestId);
  controller.abort();
}
