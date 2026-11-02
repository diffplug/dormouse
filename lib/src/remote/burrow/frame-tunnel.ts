/**
 * The frame tunnel's half of one remote-api session: frames, their HTTP
 * exchanges and WebSockets, and the flow window over all of them
 * (`docs/specs/remote-api.md` → "Frames"). Environment-free like
 * `RemoteApiSession`, which hands it every frame method; the page itself is
 * reached through a {@link BurrowFrameHost}.
 */

import {
  FRAME_CHUNK_BYTES,
  FRAME_EVENTS,
  FRAME_FLOW_WINDOW_BYTES,
  FRAME_METHODS,
  MAX_FRAMES_PER_SESSION,
  MAX_HTTP_EXCHANGES_PER_SESSION,
  MAX_HTTP_HEADER_CHARS,
  MAX_HTTP_HEADERS,
  MAX_HTTP_PATH_LENGTH,
  MAX_WEBSOCKETS_PER_SESSION,
  MAX_WS_MESSAGE_BYTES,
  MAX_WS_PROTOCOLS,
  base64UrlLength,
  concatBytes,
  frameChunks,
  fromBase64Url,
  isBoundedString,
  normalizeOrigin,
  toBase64Url,
  utf8Encode,
  type FlowAckParams,
  type FlowPauseParams,
  type FrameCloseParams,
  type FrameClosedEvent,
  type FrameOpenParams,
  type FrameOpenResult,
  type HttpCancelParams,
  type HttpRequestParams,
  type HttpResponseHead,
  type HttpWriteParams,
  type DirectoryEntry,
  type RemoteRequest,
  type WsCloseParams,
  type WsClosedEvent,
  type WsOpenParams,
  type WsOpenResult,
  type WsSendParams,
} from 'remote-lib-common';
import { clientErrorMessage } from '../../lib/errors';
import type {
  BurrowFrameHost,
  FrameHttpExchange,
  FrameSocket,
  FrameUpstream,
} from './burrow-frame-host';
import type { BurrowSurfaceProvider } from './burrow-surface-provider';

/** Coalesce window for re-checking open frames against their surfaces. */
const REVALIDATE_DEBOUNCE_MS = 150;

/** An RFC 9110 token: a method or a header name. */
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** A header value: no CR, LF, or NUL, which would split or end the field. */
const HEADER_VALUE_RE = /^[^\r\n\0]*$/;
/** Origin-form, with nothing a request line would read as its end. */
const PATH_RE = /^\/[^\s\0-\x1f\x7f]*$/;
/** `Request.destination`: empty, or a lowercase word. */
const DESTINATION_RE = /^[a-z]{0,32}$/;
const MAX_METHOD_LENGTH = 32;
export const MAX_SURFACE_ID_LENGTH = 256;
const MAX_WS_REASON_BYTES = 123;

interface Frame {
  readonly id: string;
  readonly surfaceId: string;
  /** The page's origin at the open; a surface showing another closes the frame. */
  readonly pageOrigin: string;
  readonly upstream: FrameUpstream;
}

interface Exchange {
  readonly frameId: string;
  readonly exchange: FrameHttpExchange;
  /** The `http.request`, answered with the head or failed; never left pending. */
  readonly request: RemoteRequest;
  answered: boolean;
  /** The request body is finished: no `http.write` may follow. */
  ended: boolean;
  /** The Client's page stopped reading it (`flow.pause`). */
  held: boolean;
}

interface Socket {
  readonly frameId: string;
  readonly socket: FrameSocket;
  /** The `ws.open`, answered at the open or failed; never left pending. */
  readonly request: RemoteRequest;
  /** Answered: the upstream opened. */
  open: boolean;
  /** The Client's page stopped reading it (`flow.pause`). */
  held: boolean;
  /** A Client message still arriving in fragments. */
  fragments: Uint8Array[];
  fragmentBytes: number;
  fragmentBinary: boolean;
}

/** An event the flow window orders: data spends it, the rest wait their turn. */
type QueuedPayload =
  | { readonly data: unknown }
  /** A body chunk, encoded only when it is sent, so a dropped one costs nothing. */
  | { readonly bytes: Uint8Array; wrap(encoded: string): unknown };

interface Queued {
  /** The exchange or socket it belongs to: the subscription it goes to, and what `http.cancel` drops it by. */
  readonly owner: string;
  /** Its frame, which outlives it: closing the frame drops what a finished one left queued. */
  readonly frameId: string;
  readonly event: string;
  readonly payload: QueuedPayload;
}

export interface FrameTunnelOptions {
  host: BurrowFrameHost;
  /** Whether the direct path carries this session, the only one a frame opens on. */
  isDirect(): boolean;
  provider: BurrowSurfaceProvider;
  /** The lease owner every grant of this session is held under. */
  leaseOwner: string;
  /** Whether the session collects the directory itself, and hands it to `revalidate`. */
  directoryWatched(): boolean;
  ok(request: RemoteRequest, result: unknown): void;
  fail(request: RemoteRequest, error: string): void;
  event(subId: string, event: string, data: unknown): void;
}

const FRAME_METHOD_NAMES = new Set<string>(Object.values(FRAME_METHODS));

export class FrameTunnel {
  readonly #options: FrameTunnelOptions;
  readonly #frames = new Map<string, Frame>();
  /** Frames being opened, counted against the cap with the open ones. */
  readonly #opening = new Set<string>();
  readonly #exchanges = new Map<string, Exchange>();
  readonly #sockets = new Map<string, Socket>();
  readonly #queue: Queued[] = [];
  /** Body bytes sent and not yet acknowledged. */
  #outstanding = 0;
  #paused = false;
  #unwatch: (() => void) | null = null;
  #revalidateTimer: ReturnType<typeof setTimeout> | null = null;
  #lease = 0;
  #disposed = false;

  constructor(options: FrameTunnelOptions) {
    this.#options = options;
  }

  /** Whether `method` is one of this tunnel's. */
  static owns(method: string): boolean {
    return FRAME_METHOD_NAMES.has(method);
  }

  handle(request: RemoteRequest): void {
    if (this.#disposed) return;
    switch (request.method) {
      case FRAME_METHODS.frameOpen:
        return this.#frameOpen(request);
      case FRAME_METHODS.frameClose:
        return this.#frameClose(request);
      case FRAME_METHODS.httpRequest:
        return this.#httpRequest(request);
      case FRAME_METHODS.httpWrite:
        return this.#httpWrite(request);
      case FRAME_METHODS.httpCancel:
        return this.#httpCancel(request);
      case FRAME_METHODS.wsOpen:
        return this.#wsOpen(request);
      case FRAME_METHODS.wsSend:
        return this.#wsSend(request);
      case FRAME_METHODS.wsClose:
        return this.#wsClose(request);
      case FRAME_METHODS.flowAck:
        return this.#flowAck(request);
      case FRAME_METHODS.flowPause:
        return this.#flowPause(request);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    // First, so nothing torn down below answers a session with no transport.
    this.#disposed = true;
    for (const id of [...this.#frames.keys()]) this.#closeFrame(id, null);
    this.#opening.clear();
    this.#queue.length = 0;
    this.#stopWatching();
  }

  // --- Frames ---

  #frameOpen(request: RemoteRequest): void {
    const params = request.params as Partial<FrameOpenParams> | undefined;
    const { surfaceId, pageOrigin, frameOrigin, embedderOrigins } = params ?? {};
    if (!surfaceId || !isBoundedString(surfaceId, MAX_SURFACE_ID_LENGTH)) {
      return this.#options.fail(request, 'invalid frame.open: surfaceId');
    }
    if (typeof pageOrigin !== 'string' || typeof frameOrigin !== 'string' || !Array.isArray(embedderOrigins)
      || !embedderOrigins.every((origin) => typeof origin === 'string')) {
      return this.#options.fail(request, 'invalid frame.open: origins');
    }
    // Only `frame.open` asks: the switch is one-way, so a frame open stays direct.
    if (!this.#options.isDirect()) return this.#options.fail(request, 'a frame needs a direct connection');
    const id = request.requestId;
    if (this.#idInUse(id)) return this.#options.fail(request, 'request id already in use');
    if (this.#frames.size + this.#opening.size >= MAX_FRAMES_PER_SESSION) {
      return this.#options.fail(request, 'too many frames are open');
    }
    this.#opening.add(id);
    void this.#resolveAndOpen(id, params as FrameOpenParams).then(
      (result) => {
        this.#opening.delete(id);
        if (this.#disposed) return;
        if (typeof result === 'string') this.#options.fail(request, result);
        else this.#options.ok(request, result);
      },
      (error) => {
        this.#opening.delete(id);
        if (!this.#disposed) this.#options.fail(request, `frame.open failed: ${clientErrorMessage(error)}`);
      },
    );
  }

  /**
   * The open's answer, or why it failed. Leaves the frame installed on success;
   * an open no longer in `#opening` — a `frame.close` raced it — installs none.
   */
  async #resolveAndOpen(
    id: string,
    { surfaceId, pageOrigin: expectedOrigin, frameOrigin, embedderOrigins }: FrameOpenParams,
  ): Promise<FrameOpenResult | string> {
    // The page is the surface's, never the Client's: the tunnel reaches only
    // what the person at the Burrow already embedded.
    const pageUrl = await this.#options.provider.resolveBrowser(surfaceId);
    if (!this.#opening.has(id)) return 'frame.open superseded';
    const pageOrigin = normalizeOrigin(pageUrl);
    if (!pageUrl || !pageOrigin) return `no embedded page: ${surfaceId}`;
    // The frame origin holds the storage of the page the Client last heard of.
    if (pageOrigin !== expectedOrigin) return `the page moved: ${surfaceId}`;
    const opened = await this.#options.host.open(pageUrl, {
      frameOrigin,
      embedderOrigins,
      lease: { owner: this.#options.leaseOwner, id: `f${++this.#lease}` },
    });
    if ('refused' in opened) return `frame refused: ${opened.refused}`;
    if (!this.#opening.has(id)) {
      opened.close();
      return 'frame.open superseded';
    }
    this.#frames.set(id, { id, surfaceId, pageOrigin, upstream: opened });
    this.#watch();
    // The page was read before the grant was minted, and nothing watched this
    // frame meanwhile: one that went in that time closes now.
    this.#scheduleRevalidate();
    return { path: opened.path };
  }

  #frameClose(request: RemoteRequest): void {
    const { frameId } = (request.params ?? {}) as Partial<FrameCloseParams>;
    if (typeof frameId === 'string') {
      // A close racing its own open ends the open too.
      this.#opening.delete(frameId);
      this.#closeFrame(frameId, null);
    }
    this.#options.ok(request, {});
  }

  /** End a frame and everything in it; `reason` tells the Client, `null` tells it nothing. */
  #closeFrame(id: string, reason: FrameClosedEvent['reason'] | null): void {
    const frame = this.#frames.get(id);
    if (!frame) return;
    this.#frames.delete(id);
    for (const [exchangeId, entry] of this.#exchanges) if (entry.frameId === id) this.#dropExchange(exchangeId);
    for (const [socketId, entry] of this.#sockets) if (entry.frameId === id) this.#dropSocket(socketId);
    this.#dropQueued((item) => item.frameId === id);
    frame.upstream.close();
    if (reason) this.#options.event(id, FRAME_EVENTS.frameClosed, { reason } satisfies FrameClosedEvent);
    if (this.#frames.size === 0) this.#stopWatching();
  }

  #watch(): void {
    if (this.#unwatch) return;
    this.#unwatch = this.#options.provider.watchDirectory(() => {
      // A session watching the directory collects already, and hands it to `revalidate`.
      if (!this.#options.directoryWatched()) this.#scheduleRevalidate();
    });
  }

  #stopWatching(): void {
    this.#unwatch?.();
    this.#unwatch = null;
    if (this.#revalidateTimer) {
      clearTimeout(this.#revalidateTimer);
      this.#revalidateTimer = null;
    }
  }

  #scheduleRevalidate(): void {
    if (this.#revalidateTimer || this.#disposed) return;
    this.#revalidateTimer = setTimeout(() => {
      this.#revalidateTimer = null;
      void this.#collectAndRevalidate();
    }, REVALIDATE_DEBOUNCE_MS);
  }

  async #collectAndRevalidate(): Promise<void> {
    try {
      this.revalidate(await this.#options.provider.collectDirectory());
    } catch {
      // A failed collect changes nothing.
    }
  }

  /**
   * A frame lives no longer than its surface's page: one whose surface is
   * gone, no longer embeds a page, or shows another origin, closes. A listing
   * only raises the question, being able to predate the frame or to have timed
   * out empty: the surface's owner answers it.
   */
  revalidate(entries: readonly DirectoryEntry[]): void {
    const pages = new Map(entries.flatMap((entry) => (entry.browser ? [[entry.surfaceId, entry.browser.url]] : [])));
    for (const frame of this.#frames.values()) {
      if (normalizeOrigin(pages.get(frame.surfaceId)) !== frame.pageOrigin) void this.#recheck(frame);
    }
  }

  async #recheck(frame: Frame): Promise<void> {
    const url = await this.#options.provider.resolveBrowser(frame.surfaceId).catch(() => null);
    if (normalizeOrigin(url) !== frame.pageOrigin) this.#closeFrame(frame.id, 'surface-gone');
  }

  // --- HTTP ---

  #httpRequest(request: RemoteRequest): void {
    const params = request.params as Partial<HttpRequestParams> | undefined;
    const frame = typeof params?.frameId === 'string' ? this.#frames.get(params.frameId) : undefined;
    if (!frame) return this.#options.fail(request, 'no such frame');
    const id = request.requestId;
    if (this.#idInUse(id)) return this.#options.fail(request, 'request id already in use');
    if (this.#exchanges.size >= MAX_HTTP_EXCHANGES_PER_SESSION) {
      return this.#options.fail(request, 'too many requests are open');
    }
    const { method, path, headers, destination, end } = params!;
    const invalid = validMethod(method) ?? validPath(path) ?? validHeaders(headers)
      ?? (destination === undefined || (typeof destination === 'string' && DESTINATION_RE.test(destination))
        ? null : 'destination')
      ?? (typeof end === 'boolean' ? null : 'end');
    if (invalid) return this.#options.fail(request, `invalid http.request: ${invalid}`);

    const exchange = frame.upstream.request(
      { method: method!, path: path!, headers: headers!, ...(destination !== undefined ? { destination } : {}) },
      {
        onHead: (status, statusText, responseHeaders) => {
          const entry = this.#exchanges.get(id);
          if (!entry || entry.answered) return;
          entry.answered = true;
          this.#options.ok(request, { status, statusText, headers: responseHeaders } satisfies HttpResponseHead);
        },
        onBody: (chunk) => {
          if (!this.#exchanges.get(id)?.answered) return;
          for (const bytes of frameChunks(chunk)) {
            this.#enqueue(id, frame.id, FRAME_EVENTS.httpBody, { bytes, wrap: (encoded) => ({ bytes: encoded }) });
          }
        },
        onEnd: () => {
          if (!this.#exchanges.get(id)?.answered) return;
          this.#enqueue(id, frame.id, FRAME_EVENTS.httpEnd, { data: {} });
          // Finished on its own: its queued events stay.
          this.#exchanges.delete(id);
        },
        onError: (message) => this.#failExchange(id, `upstream failed: ${message}`),
      },
    );
    this.#exchanges.set(id, { frameId: frame.id, exchange, request, answered: false, ended: end!, held: false });
    if (this.#paused) exchange.pause();
    if (end) {
      exchange.write(new Uint8Array(0), true).catch((error: unknown) => {
        this.#failExchange(id, `upstream failed: ${clientErrorMessage(error)}`);
        exchange.abort();
      });
    }
  }

  /** The exchange failed: fail its request if unanswered, else end its stream with the error. */
  #failExchange(id: string, message: string): void {
    const entry = this.#exchanges.get(id);
    if (!entry) return;
    if (entry.answered) this.#enqueue(id, entry.frameId, FRAME_EVENTS.httpError, { data: { message } });
    else {
      entry.answered = true;
      this.#options.fail(entry.request, message);
    }
    this.#exchanges.delete(id);
  }

  #httpWrite(request: RemoteRequest): void {
    const params = request.params as Partial<HttpWriteParams> | undefined;
    const id = params?.exchangeId;
    const entry = typeof id === 'string' ? this.#exchanges.get(id) : undefined;
    if (!entry || entry.ended) return this.#options.fail(request, 'no such request body');
    if (typeof params!.end !== 'boolean') return this.#options.fail(request, 'invalid http.write: end');
    const chunk = typeof params!.bytes === 'string' ? decodeChunk(params!.bytes) : null;
    if (!chunk) return this.#options.fail(request, 'invalid http.write: bytes');
    entry.ended = params!.end;
    // Answered once the upstream took it: the Client sends the next chunk only
    // then, so a slow upstream holds the upload rather than this process.
    this.#answerWhen(request, entry.exchange.write(chunk, params!.end), 'upstream failed');
  }

  #httpCancel(request: RemoteRequest): void {
    const { exchangeId } = (request.params ?? {}) as Partial<HttpCancelParams>;
    if (typeof exchangeId === 'string') {
      this.#dropExchange(exchangeId);
      // One that finished may still have events behind the window. Past this
      // answer the Client has stopped listening, and would never ack them.
      this.#dropQueued((item) => item.owner === exchangeId);
    }
    this.#options.ok(request, {});
  }

  /** End an exchange early: abort it, and fail its request if nothing answered it yet. */
  #dropExchange(id: string): void {
    const entry = this.#exchanges.get(id);
    if (!entry) return;
    this.#exchanges.delete(id);
    entry.exchange.abort();
    if (!entry.answered && !this.#disposed) this.#options.fail(entry.request, 'request cancelled');
  }

  // --- WebSockets ---

  #wsOpen(request: RemoteRequest): void {
    const params = request.params as Partial<WsOpenParams> | undefined;
    const frame = typeof params?.frameId === 'string' ? this.#frames.get(params.frameId) : undefined;
    if (!frame) return this.#options.fail(request, 'no such frame');
    const id = request.requestId;
    if (this.#idInUse(id)) return this.#options.fail(request, 'request id already in use');
    if (this.#sockets.size >= MAX_WEBSOCKETS_PER_SESSION) {
      return this.#options.fail(request, 'too many sockets are open');
    }
    const protocols = params!.protocols ?? [];
    const invalid = validPath(params!.path)
      ?? (Array.isArray(protocols) && protocols.length <= MAX_WS_PROTOCOLS
        && protocols.every((protocol) => typeof protocol === 'string' && protocol.length <= 256 && TOKEN_RE.test(protocol))
        ? null : 'protocols');
    if (invalid) return this.#options.fail(request, `invalid ws.open: ${invalid}`);

    const socket = frame.upstream.openSocket({ path: params!.path!, protocols }, {
      onOpen: (protocol, extensions) => {
        const entry = this.#sockets.get(id);
        if (!entry || entry.open) return;
        entry.open = true;
        this.#options.ok(request, { protocol, extensions } satisfies WsOpenResult);
      },
      onMessage: (data, binary) => {
        if (!this.#sockets.get(id)?.open) return;
        // An empty message is still one fragment.
        const fragments = frameChunks(data);
        fragments.forEach((bytes, index) => {
          const fin = index === fragments.length - 1;
          this.#enqueue(id, frame.id, FRAME_EVENTS.wsMessage, { bytes, wrap: (encoded) => ({ data: encoded, binary, fin }) });
        });
      },
      onClose: (code, reason) => {
        const entry = this.#sockets.get(id);
        if (!entry) return;
        if (!entry.open) this.#options.fail(request, `upstream refused the socket: ${code}`);
        else this.#enqueue(id, frame.id, FRAME_EVENTS.wsClosed, { data: { code, reason } satisfies WsClosedEvent });
        this.#sockets.delete(id);
      },
    });
    this.#sockets.set(id, {
      frameId: frame.id,
      socket,
      request,
      open: false,
      held: false,
      fragments: [],
      fragmentBytes: 0,
      fragmentBinary: false,
    });
    if (this.#paused) socket.pause();
  }

  #wsSend(request: RemoteRequest): void {
    const params = request.params as Partial<WsSendParams> | undefined;
    const id = params?.socketId;
    const entry = typeof id === 'string' ? this.#sockets.get(id) : undefined;
    if (!entry?.open) return this.#options.fail(request, 'no such socket');
    if (typeof params!.binary !== 'boolean' || typeof params!.fin !== 'boolean') {
      return this.#options.fail(request, 'invalid ws.send');
    }
    const chunk = typeof params!.data === 'string' ? decodeChunk(params!.data) : null;
    if (!chunk) return this.#options.fail(request, 'invalid ws.send: data');
    if (entry.fragments.length === 0) entry.fragmentBinary = params!.binary;
    entry.fragments.push(chunk);
    entry.fragmentBytes += chunk.length;
    if (entry.fragmentBytes > MAX_WS_MESSAGE_BYTES) {
      // The message cannot be delivered whole, so the socket ends as a peer's
      // would on an oversized message.
      entry.socket.close(1009, 'message too big');
      entry.fragments = [];
      entry.fragmentBytes = 0;
      return this.#options.fail(request, 'message too big');
    }
    if (!params!.fin) return this.#options.ok(request, {});
    const message = entry.fragments.length === 1 ? entry.fragments[0]! : concatBytes(...entry.fragments);
    entry.fragments = [];
    entry.fragmentBytes = 0;
    this.#answerWhen(request, entry.socket.send(message, entry.fragmentBinary), 'socket send failed');
  }

  #wsClose(request: RemoteRequest): void {
    const { socketId, code, reason } = (request.params ?? {}) as Partial<WsCloseParams>;
    const entry = typeof socketId === 'string' ? this.#sockets.get(socketId) : undefined;
    if (code !== undefined && !(code === 1000 || (Number.isInteger(code) && code >= 3000 && code <= 4999))) {
      return this.#options.fail(request, 'invalid ws.close: code');
    }
    if (reason !== undefined && (typeof reason !== 'string' || utf8Encode(reason).length > MAX_WS_REASON_BYTES)) {
      return this.#options.fail(request, 'invalid ws.close: reason');
    }
    // `onClose` follows the handshake, carrying the upstream's own code.
    if (entry) {
      if (entry.open) entry.socket.close(code, reason);
      else this.#dropSocket(socketId!);
    }
    this.#options.ok(request, {});
  }

  #dropSocket(id: string): void {
    const entry = this.#sockets.get(id);
    if (!entry) return;
    this.#sockets.delete(id);
    entry.socket.terminate();
    if (!entry.open && !this.#disposed) this.#options.fail(entry.request, 'socket cancelled');
  }

  // --- The flow window ---

  #flowAck(request: RemoteRequest): void {
    const { bytes } = (request.params ?? {}) as Partial<FlowAckParams>;
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
      return this.#options.fail(request, 'invalid flow.ack');
    }
    this.#outstanding = Math.max(0, this.#outstanding - bytes);
    this.#options.ok(request, {});
    this.#drain();
  }

  #flowPause(request: RemoteRequest): void {
    const { id, paused } = (request.params ?? {}) as Partial<FlowPauseParams>;
    if (typeof id !== 'string' || typeof paused !== 'boolean') {
      return this.#options.fail(request, 'invalid flow.pause');
    }
    const exchange = this.#exchanges.get(id);
    const socket = this.#sockets.get(id);
    const entry = exchange ?? socket;
    if (entry) {
      entry.held = paused;
      const source = exchange?.exchange ?? socket!.socket;
      if (paused) source.pause();
      else if (!this.#paused) source.resume();
    }
    this.#options.ok(request, {});
  }

  /** Answer `request` once `settled` does: empty on success, `failure` and why otherwise. */
  #answerWhen(request: RemoteRequest, settled: Promise<void>, failure: string): void {
    settled.then(
      () => { if (!this.#disposed) this.#options.ok(request, {}); },
      (error: unknown) => { if (!this.#disposed) this.#options.fail(request, `${failure}: ${clientErrorMessage(error)}`); },
    );
  }

  /**
   * Put one event behind every one already waiting, then send what the window
   * allows. One queue for the whole session, so an exchange's end never
   * overtakes its own body.
   */
  #enqueue(owner: string, frameId: string, event: string, payload: QueuedPayload): void {
    if (this.#disposed) return;
    this.#queue.push({ owner, frameId, event, payload });
    this.#drain();
  }

  #drain(): void {
    while (this.#queue.length > 0) {
      const head = this.#queue[0]!;
      const { payload } = head;
      const bytes = 'bytes' in payload ? payload.bytes.length : 0;
      // A chunk larger than what is left still goes once nothing is in flight,
      // so the window can never wedge.
      if (bytes > 0 && this.#outstanding > 0 && this.#outstanding + bytes > FRAME_FLOW_WINDOW_BYTES) break;
      this.#queue.shift();
      this.#outstanding += bytes;
      const data = 'bytes' in payload ? payload.wrap(toBase64Url(payload.bytes)) : payload.data;
      this.#options.event(head.owner, head.event, data);
    }
    // Resumed only once half the window is free, or every small ack would
    // restart every source for the next chunk to stop them again.
    const full = this.#paused ? FRAME_FLOW_WINDOW_BYTES / 2 : FRAME_FLOW_WINDOW_BYTES;
    this.#setPaused(this.#queue.length > 0 || this.#outstanding >= full);
  }

  #setPaused(paused: boolean): void {
    if (paused === this.#paused) return;
    this.#paused = paused;
    for (const { exchange, held } of this.#exchanges.values()) {
      if (paused) exchange.pause();
      else if (!held) exchange.resume();
    }
    for (const { socket, held } of this.#sockets.values()) {
      if (paused) socket.pause();
      else if (!held) socket.resume();
    }
  }

  #dropQueued(dropped: (item: Queued) => boolean): void {
    let kept = 0;
    for (const item of this.#queue) if (!dropped(item)) this.#queue[kept++] = item;
    this.#queue.length = kept;
  }

  /** Every id a Client message can name, since one id names one thing. */
  #idInUse(id: string): boolean {
    return this.#frames.has(id) || this.#opening.has(id) || this.#exchanges.has(id) || this.#sockets.has(id);
  }
}

function validMethod(method: unknown): string | null {
  if (typeof method !== 'string' || method.length > MAX_METHOD_LENGTH || !TOKEN_RE.test(method)) return 'method';
  // A tunnel, not a forwarder: CONNECT asks the proxy to become one.
  return method.toUpperCase() === 'CONNECT' ? 'method' : null;
}

function validPath(path: unknown): string | null {
  return typeof path === 'string' && path.length <= MAX_HTTP_PATH_LENGTH && PATH_RE.test(path) ? null : 'path';
}

function validHeaders(headers: unknown): string | null {
  if (!Array.isArray(headers) || headers.length > MAX_HTTP_HEADERS) return 'headers';
  let chars = 0;
  for (const header of headers as unknown[]) {
    if (!Array.isArray(header) || header.length !== 2) return 'headers';
    const [name, value] = header as [unknown, unknown];
    if (typeof name !== 'string' || typeof value !== 'string') return 'headers';
    if (!TOKEN_RE.test(name) || !HEADER_VALUE_RE.test(value)) return 'headers';
    chars += name.length + value.length;
  }
  return chars <= MAX_HTTP_HEADER_CHARS ? null : 'headers';
}

/** One body chunk off the wire, or `null` when it is malformed or over the chunk size. */
function decodeChunk(encoded: string): Uint8Array | null {
  // Four base64url characters carry three bytes, so this refuses an oversized
  // chunk before decoding it.
  if (encoded.length > base64UrlLength(FRAME_CHUNK_BYTES)) return null;
  try {
    const bytes = fromBase64Url(encoded);
    return bytes.length <= FRAME_CHUNK_BYTES ? bytes : null;
  } catch {
    return null;
  }
}
