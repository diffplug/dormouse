/**
 * The messages between a frame origin's service worker, its bootstrap page, and
 * the Client window that holds the session (`docs/specs/pocket-app.md` → scope
 * pocket-frames). None of these cross the session: `FrameClient` speaks that.
 */

import type { HttpHeader, HttpResponseHead, WsOpenResult } from 'remote-lib-common';

/** One request a framed page made, with a port carrying its answer. */
export interface RelayRequest {
  kind: 'request';
  method: string;
  path: string;
  headers: HttpHeader[];
  destination: string;
  body?: ArrayBuffer;
}

/** One socket a framed page opened, with a port carrying the rest of it. */
export interface RelaySocket {
  kind: 'socket';
  path: string;
  protocols: string[];
}

export type RelayMessage = RelayRequest | RelaySocket;

/** The Client window's answer to a {@link RelayRequest}. */
export type ResponseMessage =
  | ({ kind: 'head' } & HttpResponseHead)
  | { kind: 'chunk'; bytes: Uint8Array }
  | { kind: 'end' }
  | { kind: 'error'; message: string };

/** The worker asking for the next chunk or for no more, or saying it still runs. */
export type ResponseControl = { kind: 'pull' } | { kind: 'cancel' } | { kind: 'alive' };

/**
 * How often a worker serving a response says it still runs. A stopped worker
 * tells a port nothing, and its exchange would hold one of the session's few.
 */
export const WORKER_ALIVE_MS = 10_000;
/** How long the Client window hears nothing before ending a response. */
export const WORKER_SILENCE_LIMIT_MS = WORKER_ALIVE_MS * 3;

/** A socket's messages, Client window to page. */
export type SocketEvent =
  | ({ kind: 'open' } & WsOpenResult)
  | { kind: 'message'; data: ArrayBuffer; binary: boolean }
  /** One `send` left the phone, so the page's `bufferedAmount` falls. */
  | { kind: 'sent'; bytes: number }
  | { kind: 'closed'; code: number; reason: string };

/** A socket's messages, page to Client window. */
export type SocketCommand =
  | { kind: 'send'; data: ArrayBuffer | Blob; binary: boolean }
  | { kind: 'close'; code?: number; reason?: string };

/** Parent to bootstrap: the port every relay message goes through. */
export interface BootstrapConnect {
  kind: 'dormouse-frame-connect';
}
/** Bootstrap to Client window: the worker is active, so a frame may load. */
export interface BootstrapReady {
  kind: 'ready';
}
