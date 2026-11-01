// ---------------------------------------------------------------------------
// The frame tunnel: a surface's embedded page, carried over protocol-v1
// (`docs/specs/remote-api.md` -> "Frames"). The Client frames the page at an
// origin of its own; every request that page makes rides this session to the
// Burrow, which answers it through the same iframe proxy a local pane uses.
// These ride as application messages on an authorized Noise session, beside
// the terminal methods in `wire.ts`.

export const FRAME_METHODS = {
  frameOpen: 'frame.open',
  frameClose: 'frame.close',
  httpRequest: 'http.request',
  httpWrite: 'http.write',
  httpCancel: 'http.cancel',
  wsOpen: 'ws.open',
  wsSend: 'ws.send',
  wsClose: 'ws.close',
  flowAck: 'flow.ack',
  flowPause: 'flow.pause',
} as const;

export const FRAME_EVENTS = {
  /** On a `frame.open` subscription: the frame is gone, and every exchange in it. */
  frameClosed: 'frame.closed',
  /** On an `http.request` subscription, after its answer (the head). */
  httpBody: 'http.body',
  httpEnd: 'http.end',
  httpError: 'http.error',
  /** On a `ws.open` subscription, after its answer (the open). */
  wsMessage: 'ws.message',
  wsClosed: 'ws.closed',
} as const;

/**
 * The most body bytes one `http.body`, `http.write`, `ws.message`, or `ws.send`
 * carries, before base64url. Comfortably inside one application message
 * (`MAX_APP_MESSAGE_LENGTH`) once encoded and framed.
 */
export const FRAME_CHUNK_BYTES = 192 * 1024;

/**
 * How many Burrow→Client body bytes, before base64url, may be sent and not yet
 * acknowledged by `flow.ack` across one session's every exchange and socket.
 * Encoded, it stays well inside the direct path's sender queue
 * (`MAX_DIRECT_PENDING_BYTES`), whose overflow ends the session.
 */
export const FRAME_FLOW_WINDOW_BYTES = 1024 * 1024;

/** Frames one session may hold open at once. */
export const MAX_FRAMES_PER_SESSION = 4;
/** HTTP exchanges one session may hold open at once, across its frames. */
export const MAX_HTTP_EXCHANGES_PER_SESSION = 32;
/** WebSockets one session may hold open at once, across its frames. */
export const MAX_WEBSOCKETS_PER_SESSION = 8;
/** Header fields one request may carry. */
export const MAX_HTTP_HEADERS = 128;
/** The UTF-16 length of one request's header names and values together. */
export const MAX_HTTP_HEADER_CHARS = 32 * 1024;
/** The longest request path (origin-form: path and query). */
export const MAX_HTTP_PATH_LENGTH = 8 * 1024;
/** The largest WebSocket message either side reassembles from its fragments. */
export const MAX_WS_MESSAGE_BYTES = 16 * 1024 * 1024;
/** Subprotocols one `ws.open` may offer. */
export const MAX_WS_PROTOCOLS = 16;

/** One header field. A list, not a record, so repeated fields survive. */
export type HttpHeader = [name: string, value: string];

export interface HelloCapabilities {
  /** The Client frames embedded pages through the frame tunnel. */
  frames?: boolean;
}

/**
 * A surface's embedded page, as the directory describes it to a Client whose
 * hello declared {@link HelloCapabilities.frames}. `render` names how a Client
 * may show it; one this build does not know is skipped.
 */
export interface DirectoryBrowser {
  render: 'iframe';
  /** The page the surface shows now, as its chrome does. */
  url: string;
  /** The page's title, where it has reported one. */
  title?: string;
}

export interface FrameOpenParams {
  surfaceId: string;
  /** The origin the Client frames the page at, which the tunnel stands in for. */
  frameOrigin: string;
  /**
   * Who may frame it: the framing document's origin, then its ancestors' —
   * `location.origin` plus `location.ancestorOrigins` in that document.
   */
  embedderOrigins: string[];
}
export interface FrameOpenResult {
  /** Where the Client frames the page: a path, query, and fragment at {@link FrameOpenParams.frameOrigin}. */
  path: string;
  /** The page the surface showed when the frame opened. */
  url: string;
}
export interface FrameClosedEvent {
  /** The surface's page is gone or moved to another origin; a frame the Client closed is told nothing. */
  reason: 'surface-gone';
}
export interface FrameCloseParams {
  /** The `frame.open` request's id. */
  frameId: string;
}

export interface HttpRequestParams {
  frameId: string;
  method: string;
  /** Origin-form: a path and query, starting with `/`. */
  path: string;
  headers: HttpHeader[];
  /**
   * The request's fetch destination (`Request.destination`), which decides
   * whether a document comes back instrumented; absent reads as a document.
   */
  destination?: string;
  /** The first body chunk, base64url. */
  body?: string;
  /** No body follows in `http.write`. */
  end: boolean;
}
export interface HttpResponseHead {
  status: number;
  statusText: string;
  headers: HttpHeader[];
}
export interface HttpWriteParams {
  /** The `http.request`'s request id. */
  exchangeId: string;
  /** Base64url. */
  bytes: string;
  end: boolean;
}
export interface HttpCancelParams {
  exchangeId: string;
}
export interface HttpBodyEvent {
  /** Base64url. */
  bytes: string;
}
export interface HttpErrorEvent {
  message: string;
}

export interface WsOpenParams {
  frameId: string;
  /** Origin-form, as {@link HttpRequestParams.path}. */
  path: string;
  protocols?: string[];
}
export interface WsOpenResult {
  protocol: string;
  extensions: string;
}
/** One fragment of a WebSocket message; `fin` ends the message. */
export interface WsMessageFragment {
  /** Base64url. */
  data: string;
  binary: boolean;
  fin: boolean;
}
export interface WsSendParams extends WsMessageFragment {
  /** The `ws.open`'s request id. */
  socketId: string;
}
export interface WsCloseParams {
  socketId: string;
  code?: number;
  reason?: string;
}
export interface WsClosedEvent {
  code: number;
  reason: string;
}

export interface FlowAckParams {
  /**
   * Body bytes, before base64url, the Client has taken off the session since
   * its last ack — on receipt, never when its page reads them, so a page that
   * stops reading holds its own exchange (`flow.pause`) and not the session.
   */
  bytes: number;
}
export interface FlowPauseParams {
  /** The `http.request` or `ws.open` request's id. */
  id: string;
  /** Stop or restart this one source; an id no longer live is ignored. */
  paused: boolean;
}
