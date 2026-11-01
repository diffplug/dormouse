/**
 * The messages between a frame origin's service worker, its bootstrap page, and
 * the Client window that holds the session (`docs/specs/pocket-app.md` → scope
 * pocket-frames). None of these cross the session: `FrameClient` speaks that.
 */

import type { HttpHeader, HttpResponseHead, WsOpenResult } from 'remote-lib-common';

/** At the origin root, so its default scope is the whole origin. */
export const FRAME_WORKER_PATH = '/__dormouse-frame-sw.js';
export const FRAME_BOOTSTRAP_PATH = '/__dormouse-frame/bootstrap.html';
const FRAME_ASSET_PREFIX = '/__dormouse-frame/';

/** Whether a path is the frame origin's own, never the page's. */
export function isFrameAssetPath(pathname: string): boolean {
  return pathname === FRAME_WORKER_PATH || pathname.startsWith(FRAME_ASSET_PREFIX);
}

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

/** The worker asking for the next chunk, or for no more. */
export type ResponseControl = { kind: 'pull' } | { kind: 'cancel' };

/** A socket's messages, Client window to page. */
export type SocketEvent =
  | ({ kind: 'open' } & WsOpenResult)
  | { kind: 'message'; data: ArrayBuffer; binary: boolean }
  | { kind: 'closed'; code: number; reason: string };

/** A socket's messages, page to Client window. */
export type SocketCommand =
  | { kind: 'send'; data: ArrayBuffer; binary: boolean }
  | { kind: 'close'; code?: number; reason?: string };

/** Parent to bootstrap: the port every relay message goes through. */
export interface BootstrapConnect {
  kind: 'dormouse-frame-connect';
}
/** Bootstrap to Client window: the worker is active, so a frame may load. */
export interface BootstrapReady {
  kind: 'ready';
}
