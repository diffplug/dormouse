/**
 * Environment-free seam between the frame tunnel and the process that can
 * reach a page (`docs/specs/remote-api.md` → "Frames"). Types only: the Node
 * implementation is `createBurrowFrameHost` in
 * `lib/src/host/remote/frame-host.ts`.
 */

import type { HttpHeader } from 'remote-lib-common';

export type { HttpHeader };

/** One request a framed page made, as the tunnel forwards it. */
export interface FrameHttpInit {
  method: string;
  /** Origin-form: a path and query, starting with `/`. */
  path: string;
  headers: readonly HttpHeader[];
  /** The fetch destination; absent reads as a document. */
  destination?: string;
}

/** Where one exchange's response goes, in order: a head, body chunks, then an end or an error. */
export interface FrameHttpSink {
  onHead(status: number, statusText: string, headers: HttpHeader[]): void;
  onBody(chunk: Uint8Array): void;
  onEnd(): void;
  /** Ends the exchange, before or after its head. */
  onError(message: string): void;
}

export interface FrameHttpExchange {
  /**
   * Send a request body chunk upstream; `end` finishes the request. Settles
   * once the upstream has taken it, which is the Client's backpressure.
   */
  write(chunk: Uint8Array, end: boolean): Promise<void>;
  /** Stop and restart delivering response body chunks — the flow window. */
  pause(): void;
  resume(): void;
  /** Drop the exchange; nothing more reaches the sink. Idempotent. */
  abort(): void;
}

export interface FrameSocketInit {
  path: string;
  protocols: readonly string[];
}

export interface FrameSocketSink {
  onOpen(protocol: string, extensions: string): void;
  /** One whole message. */
  onMessage(data: Uint8Array, binary: boolean): void;
  /** The socket is gone, opened or not. Called once; nothing follows it. */
  onClose(code: number, reason: string): void;
}

export interface FrameSocket {
  /** One whole message; settles once it is written. */
  send(data: Uint8Array, binary: boolean): Promise<void>;
  /** Start the closing handshake; `onClose` follows. */
  close(code?: number, reason?: string): void;
  pause(): void;
  resume(): void;
  /** Drop the socket at once; nothing more reaches the sink. Idempotent. */
  terminate(): void;
}

/** One page reachable through a proxy grant, held until {@link close}. */
export interface FrameUpstream {
  /** Where the Client frames the page: path, query, and fragment. */
  readonly path: string;
  request(init: FrameHttpInit, sink: FrameHttpSink): FrameHttpExchange;
  openSocket(init: FrameSocketInit, sink: FrameSocketSink): FrameSocket;
  /** End the grant, every exchange and socket on it included. Idempotent. */
  close(): void;
}

export interface FrameOpenOptions {
  /** The Client's frame origin, which the tunnel stands in for upstream. */
  frameOrigin: string;
  /** The Client's framing chain, the grant's embedder chain. */
  embedderOrigins: readonly string[];
  /** The grant's lease, owned by the session, so it is not a webview's. */
  lease: { owner: string; id: string };
}

export interface BurrowFrameHost {
  /** Mint a grant for `url`, or say why there is none. */
  open(url: string, options: FrameOpenOptions): Promise<FrameUpstream | { refused: string }>;
}
