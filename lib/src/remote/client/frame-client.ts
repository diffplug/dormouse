/**
 * The Client's half of the frame tunnel protocol (`docs/specs/remote-api.md` →
 * "Frames"): frames, their requests as `ReadableStream` responses, and their
 * sockets, over one authorized session. No DOM and no worker; what a framed
 * page's requests travel through to get here is `../frame-origin/`.
 */

import {
  FRAME_CHUNK_BYTES,
  FRAME_EVENTS,
  FRAME_FLOW_WINDOW_BYTES,
  FRAME_METHODS,
  MAX_HTTP_EXCHANGES_PER_SESSION,
  concatBytes,
  fromBase64Url,
  toBase64Url,
  type FrameClosedEvent,
  type FrameOpenResult,
  type HttpBodyEvent,
  type HttpErrorEvent,
  type HttpHeader,
  type HttpRequestParams,
  type HttpResponseHead,
  type RemoteEventMsg,
  type WsClosedEvent,
  type WsMessageFragment,
  type WsOpenResult,
} from 'remote-lib-common';

/** What the tunnel needs of a session; `PocketClient` and `OneTimeClient` both are one. */
export interface FrameSession {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  subscribe<T = unknown>(
    method: string,
    params: unknown,
    onEvent: (event: RemoteEventMsg) => void,
    subId?: string,
  ): Promise<{ subId: string; result: T }>;
  unsubscribe(subId: string): void;
}

/** A coalesced `flow.ack` once this many body bytes wait, or {@link ACK_FLUSH_MS} later. */
const ACK_THRESHOLD_BYTES = 64 * 1024;
/** What a response may queue for its page before its exchange is held. */
const RESPONSE_BUFFER_BYTES = 256 * 1024;
/** How long fewer acknowledged bytes than the threshold wait: a page's hundreds of small modules share one ack. */
const ACK_FLUSH_MS = 50;

export interface FrameRequestInit {
  method: string;
  /** Origin-form: a path and query. */
  path: string;
  headers: HttpHeader[];
  /** `Request.destination`. */
  destination?: string;
  body?: Uint8Array;
}

export interface FrameResponse extends HttpResponseHead {
  /** Cancelling it cancels the exchange. */
  readonly body: ReadableStream<Uint8Array>;
}

export interface FrameSocketHandlers {
  onMessage(data: Uint8Array, binary: boolean): void;
  onClose(code: number, reason: string): void;
}

export interface OpenFrameSocket extends WsOpenResult {
  /** One whole message, sent in order; settles once the upstream took it. */
  send(data: Uint8Array, binary: boolean): Promise<void>;
  close(code?: number, reason?: string): void;
}

export interface OpenFrame extends FrameOpenResult {
  readonly id: string;
  request(init: FrameRequestInit): Promise<FrameResponse>;
  openSocket(path: string, protocols: string[], handlers: FrameSocketHandlers): Promise<OpenFrameSocket>;
  /** End the frame, and everything in it. Idempotent. */
  close(): void;
}

export interface FrameOpenInit {
  surfaceId: string;
  /** The page origin {@link frameOrigin} belongs to; the Burrow refuses any other. */
  pageOrigin: string;
  frameOrigin: string;
  embedderOrigins: string[];
  /** The Burrow closed the frame: the surface's page went away. */
  onClosed?(reason: FrameClosedEvent['reason']): void;
}

/** Something in flight on a frame, ended with it. */
type Live = (reason: string) => void;

/**
 * The exchanges a session may hold, waited for in order: a page can ask for
 * hundreds of modules at once, and with no connection limit in front of a
 * service worker, the Burrow's bound is the first one they would meet.
 */
class ExchangeSlots {
  #free = MAX_HTTP_EXCHANGES_PER_SESSION;
  readonly #waiting: Array<() => void> = [];

  acquire(): Promise<void> {
    if (this.#free > 0) {
      this.#free -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  release(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#free += 1;
  }
}

/**
 * The body bytes a session may have sent and not had answered, across its every
 * upload and socket, taken in order so none starves. One upstream that stopped
 * reading holds its share until it fails or its frame closes.
 */
class SendWindow {
  #inFlight = 0;
  readonly #waiting: Array<{ bytes: number; go(): void }> = [];

  async send<T>(bytes: number, sending: () => Promise<T>): Promise<T> {
    if (this.#waiting.length > 0 || this.#inFlight + bytes > FRAME_FLOW_WINDOW_BYTES) {
      await new Promise<void>((go) => this.#waiting.push({ bytes, go }));
    } else {
      this.#inFlight += bytes;
    }
    try {
      return await sending();
    } finally {
      this.#inFlight -= bytes;
      this.#admit();
    }
  }

  #admit(): void {
    while (this.#waiting.length > 0 && this.#inFlight + this.#waiting[0]!.bytes <= FRAME_FLOW_WINDOW_BYTES) {
      const next = this.#waiting.shift()!;
      this.#inFlight += next.bytes;
      next.go();
    }
  }
}

export class FrameClient {
  readonly #session: FrameSession;
  readonly #frames = new Set<ClientFrame>();
  readonly #slots = new ExchangeSlots();
  readonly #sends = new SendWindow();
  #unacked = 0;
  #ackTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor(session: FrameSession) {
    this.#session = session;
  }

  async open(init: FrameOpenInit): Promise<OpenFrame> {
    if (this.#disposed) throw new Error(SESSION_ENDED);
    const id = globalThis.crypto.randomUUID();
    let frame: ClientFrame | null = null;
    const { result } = await this.#session.subscribe<FrameOpenResult>(
      FRAME_METHODS.frameOpen,
      { surfaceId: init.surfaceId, pageOrigin: init.pageOrigin, frameOrigin: init.frameOrigin, embedderOrigins: init.embedderOrigins },
      (event) => {
        if (event.event !== FRAME_EVENTS.frameClosed) return;
        frame?.ended('the embedded page closed');
        init.onClosed?.((event.data as FrameClosedEvent).reason);
      },
      id,
    );
    frame = new ClientFrame(id, result, this.#session, this.#slots, this.#sends, (bytes) => this.#received(bytes), () => {
      this.#frames.delete(frame!);
      this.#session.unsubscribe(id);
    });
    if (this.#disposed) frame.ended(SESSION_ENDED);
    else this.#frames.add(frame);
    return frame;
  }

  /** The session is gone: fail everything in flight; no more is sent. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#ackTimer) clearTimeout(this.#ackTimer);
    for (const frame of [...this.#frames]) frame.ended(SESSION_ENDED);
  }

  /**
   * Off the session, whatever happens to it next — an exchange the page
   * cancelled included, or the Burrow's window would shrink for good.
   */
  #received(bytes: number): void {
    this.#unacked += bytes;
    if (this.#unacked >= ACK_THRESHOLD_BYTES) this.#flushAck();
    else if (!this.#ackTimer && this.#unacked > 0) this.#ackTimer = setTimeout(() => this.#flushAck(), ACK_FLUSH_MS);
  }

  #flushAck(): void {
    if (this.#ackTimer) clearTimeout(this.#ackTimer);
    this.#ackTimer = null;
    if (this.#unacked === 0 || this.#disposed) return;
    const bytes = this.#unacked;
    this.#unacked = 0;
    fireAndForget(this.#session.request(FRAME_METHODS.flowAck, { bytes }));
  }
}

const SESSION_ENDED = 'the session ended';

function fireAndForget(sent: Promise<unknown>): void {
  void sent.catch(() => {});
}

class ClientFrame implements OpenFrame {
  readonly id: string;
  readonly path: string;
  readonly #session: FrameSession;
  readonly #slots: ExchangeSlots;
  readonly #sends: SendWindow;
  /** Body bytes off the wire. */
  readonly #received: (bytes: number) => void;
  readonly #forget: () => void;
  readonly #live = new Set<Live>();
  #ended = false;

  constructor(
    id: string,
    opened: FrameOpenResult,
    session: FrameSession,
    slots: ExchangeSlots,
    sends: SendWindow,
    received: (bytes: number) => void,
    forget: () => void,
  ) {
    this.id = id;
    this.path = opened.path;
    this.#session = session;
    this.#slots = slots;
    this.#sends = sends;
    this.#received = received;
    this.#forget = forget;
  }

  async request(init: FrameRequestInit): Promise<FrameResponse> {
    if (this.#ended) throw new Error('the frame is closed');
    await this.#slots.acquire();
    if (this.#ended) {
      this.#slots.release();
      throw new Error('the frame is closed');
    }
    const id = globalThis.crypto.randomUUID();
    const session = this.#session;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let held = false;
    let done = false;

    const hold = (paused: boolean): void => {
      if (held === paused || done) return;
      held = paused;
      fireAndForget(session.request(FRAME_METHODS.flowPause, { id, paused }));
    };
    const release = (): void => {
      session.unsubscribe(id);
      this.#slots.release();
    };
    const finish = (): void => {
      done = true;
      this.#live.delete(endLive);
      release();
    };
    const endLive: Live = (reason) => {
      if (done) return;
      finish();
      controller.error(new Error(reason));
    };

    const body = new ReadableStream<Uint8Array>({
      start: (c) => { controller = c; },
      // Restarted only once half the buffer is free, or a page reading slower
      // than the tunnel would hold and release its exchange for every chunk.
      pull: () => { if ((controller.desiredSize ?? 0) >= RESPONSE_BUFFER_BYTES / 2) hold(false); },
      cancel: () => {
        if (done) return;
        done = true;
        this.#live.delete(endLive);
        // Its subscription outlives the cancel until the answer: what the
        // Burrow already sent still arrives, and is still owed an ack.
        session.request(FRAME_METHODS.httpCancel, { exchangeId: id }).then(release, release);
      },
    }, new ByteLengthQueuingStrategy({ highWaterMark: RESPONSE_BUFFER_BYTES }));

    this.#live.add(endLive);
    const bytes = init.body ?? new Uint8Array(0);
    const params: HttpRequestParams = {
      frameId: this.id,
      method: init.method,
      path: init.path,
      headers: init.headers,
      ...(init.destination !== undefined ? { destination: init.destination } : {}),
      end: bytes.length === 0,
    };
    const answered = session.subscribe<HttpResponseHead>(FRAME_METHODS.httpRequest, params, (event) => {
      switch (event.event) {
        case FRAME_EVENTS.httpBody: {
          const chunk = fromBase64Url((event.data as HttpBodyEvent).bytes);
          this.#received(chunk.length);
          if (done) return;
          controller.enqueue(chunk);
          if ((controller.desiredSize ?? 0) <= 0) hold(true);
          return;
        }
        case FRAME_EVENTS.httpEnd:
          if (done) return;
          finish();
          controller.close();
          return;
        case FRAME_EVENTS.httpError:
          endLive((event.data as HttpErrorEvent).message);
          return;
      }
    }, id);
    if (!params.end) void this.#upload(id, bytes);

    try {
      const { result } = await answered;
      return { ...result, body };
    } catch (error) {
      endLive(error instanceof Error ? error.message : 'request failed');
      throw error;
    }
  }

  /** One body chunk through the session's window, encoded only once it may go. */
  #sendChunk(method: string, bytes: Uint8Array, params: (encoded: string) => unknown): Promise<unknown> {
    return this.#sends.send(bytes.length, () => {
      if (this.#ended) return Promise.reject(new Error('the frame is closed'));
      return this.#session.request(method, params(toBase64Url(bytes)));
    });
  }

  /** The body, each chunk sent once the upstream took the last. */
  async #upload(exchangeId: string, bytes: Uint8Array): Promise<void> {
    try {
      for (let offset = 0; offset < bytes.length; offset += FRAME_CHUNK_BYTES) {
        const next = offset + FRAME_CHUNK_BYTES;
        await this.#sendChunk(FRAME_METHODS.httpWrite, bytes.subarray(offset, next), (encoded) => ({
          exchangeId,
          bytes: encoded,
          end: next >= bytes.length,
        }));
      }
    } catch {
      // The exchange failed; its `http.request` or `http.error` says why.
    }
  }

  async openSocket(path: string, protocols: string[], handlers: FrameSocketHandlers): Promise<OpenFrameSocket> {
    if (this.#ended) throw new Error('the frame is closed');
    const id = globalThis.crypto.randomUUID();
    const session = this.#session;
    let parts: Uint8Array[] = [];
    let open = true;
    const end = (code: number, reason: string): void => {
      if (!open) return;
      open = false;
      this.#live.delete(endLive);
      session.unsubscribe(id);
      handlers.onClose(code, reason);
    };
    // 1006: the abnormal closure a page would see of a connection that just went.
    const endLive: Live = (reason) => end(1006, reason);

    this.#live.add(endLive);
    let result: WsOpenResult;
    try {
      ({ result } = await session.subscribe<WsOpenResult>(FRAME_METHODS.wsOpen, { frameId: this.id, path, protocols }, (event) => {
        if (event.event === FRAME_EVENTS.wsMessage) {
          const fragment = event.data as WsMessageFragment;
          const chunk = fromBase64Url(fragment.data);
          this.#received(chunk.length);
          if (!open) return;
          parts.push(chunk);
          if (!fragment.fin) return;
          const message = parts.length === 1 ? parts[0]! : concatBytes(...parts);
          parts = [];
          handlers.onMessage(message, fragment.binary);
        } else if (event.event === FRAME_EVENTS.wsClosed) {
          const { code, reason } = event.data as WsClosedEvent;
          end(code, reason);
        }
      }, id));
    } catch (error) {
      open = false;
      this.#live.delete(endLive);
      throw error;
    }

    let sending: Promise<void> = Promise.resolve();
    return {
      ...result,
      send: (data, binary) => {
        const sent = sending.then(() => this.#sendFragments(id, data, binary));
        sending = sent.catch(() => {});
        return sent;
      },
      // Behind what was sent before it, as a socket's own close is.
      close: (code, reason) => {
        void sending.then(() => {
          if (!open) return;
          fireAndForget(session.request(FRAME_METHODS.wsClose, {
            socketId: id,
            ...(code !== undefined ? { code } : {}),
            ...(reason !== undefined ? { reason } : {}),
          }));
        });
      },
    };
  }

  async #sendFragments(socketId: string, data: Uint8Array, binary: boolean): Promise<void> {
    // An empty message is still one fragment.
    let offset = 0;
    do {
      const next = offset + FRAME_CHUNK_BYTES;
      await this.#sendChunk(FRAME_METHODS.wsSend, data.subarray(offset, next), (encoded) => ({
        socketId,
        data: encoded,
        binary,
        fin: next >= data.length,
      }));
      offset = next;
    } while (offset < data.length);
  }

  close(): void {
    if (this.#ended) return;
    const settled = () => this.ended('the frame is closed');
    // Ended once answered, not before: what the Burrow sent ahead of the close
    // still arrives, and is still owed an ack.
    this.#session.request(FRAME_METHODS.frameClose, { frameId: this.id }).then(settled, settled);
  }

  /** The frame is over: fail what is in flight on it. */
  ended(reason: string): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const live of [...this.#live]) live(reason);
    this.#forget();
  }
}
