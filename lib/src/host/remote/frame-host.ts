/**
 * The Node half of the frame tunnel (`docs/specs/remote-api.md` → "Frames"):
 * each frame is a lease on the same iframe proxy a local pane frames
 * (`docs/specs/dor-browser.md` → "Iframe Renderer"), and every request a
 * Client's page makes is replayed against that grant as a loopback caller
 * would make it. So the proxy's whole policy — the pinned upstream, the header
 * rewriting, the shim, the error pages — applies unchanged, and the tunnel only
 * translates between the Client's frame origin and the grant's own.
 */

import * as http from 'http';
import type { Readable } from 'stream';
import WebSocket from 'ws';
import { MAX_WS_MESSAGE_BYTES, normalizeOrigin, type HttpHeader } from 'remote-lib-common';
import { messageOf } from '../../lib/errors';
import { settleAllWithin } from '../../lib/settle-within';
import type {
  BurrowFrameHost,
  FrameHttpExchange,
  FrameHttpInit,
  FrameHttpSink,
  FrameSocket,
  FrameSocketInit,
  FrameSocketSink,
  FrameUpstream,
} from '../../remote/burrow/burrow-frame-host';
import type { IframeProxyResult } from '../../lib/platform/iframe-proxy-types';
import { HOP_BY_HOP_RESPONSE_HEADERS, REMOTE_LEASE_OWNER_PREFIX, normalizeEmbedderOrigins, rewriteOrigin } from '../iframe-proxy-rewrite';

/**
 * Request fields the tunnel never forwards: the connection's own, what it sets
 * itself, and what the proxy would drop anyway. `Sec-` fields are the
 * browser's, which it never hands a service worker; the destination the
 * Client names stands in for `Sec-Fetch-Dest`.
 */
const DROPPED_REQUEST_HEADERS = new Set([...HOP_BY_HOP_RESPONSE_HEADERS, 'host', 'cookie', 'accept-encoding']);
/** The proxy's own grant is one hop away; a stall here is the proxy's to report. */
const GRANT_IDLE_TIMEOUT_MS = 60_000;

/**
 * The host's own iframe proxy — the instance its local panes frame through, so
 * one lease bound and one set of grants cover both.
 */
export interface FrameHostProxy {
  create(
    url: string,
    options: { embedderOrigins: string[]; lease: { owner: string; id: string }; tunneled: true },
  ): Promise<IframeProxyResult>;
  release(owner: string, id: string): void;
  isLocal(url: string): Promise<boolean>;
}

/** How long a page's answer stands: a directory is collected on every pane change. */
const LOCAL_ANSWER_TTL_MS = 30_000;
/**
 * A slow name must not hold up the listing. It stands on its last answer, for a
 * page a slow lookup must not make look closed; a new name is left out until it
 * answers.
 */
const LOCAL_ANSWER_BUDGET_MS = 1_000;

export function createBurrowFrameHost(proxy: FrameHostProxy): BurrowFrameHost {
  const answers = new Map<string, { at: number; local: Promise<boolean>; known: boolean }>();
  return {
    canOpen(url) {
      const now = Date.now();
      // By origin, which is all it depends on: a page's query is no new lookup.
      const key = normalizeOrigin(url);
      if (!key) return Promise.resolve(false);
      let answer = answers.get(key);
      if (!answer || now - answer.at > LOCAL_ANSWER_TTL_MS) {
        const known = answer?.known ?? false;
        // A lookup that failed is no answer either: a name can stop resolving for a moment.
        const fresh = { at: now, local: proxy.isLocal(url).catch(() => known), known };
        void fresh.local.then((value) => { fresh.known = value; });
        answers.set(key, fresh);
        answer = fresh;
      }
      return settleAllWithin([answer.local], LOCAL_ANSWER_BUDGET_MS, answer.known).then(([local]) => local);
    },
    async open(url, { frameOrigin, embedderOrigins, lease: sessionLease }) {
      const [origin] = normalizeEmbedderOrigins([frameOrigin]) ?? [];
      if (!origin) return { refused: 'invalid frame origin' };
      // Without a chain the proxy would frame for nobody and inject nothing,
      // which no Client can show.
      const chain = normalizeEmbedderOrigins(embedderOrigins);
      if (!chain) return { refused: 'invalid embedder origins' };
      // Prefixed, so a window's lease sweep never ends a session's.
      const lease = { owner: `${REMOTE_LEASE_OWNER_PREFIX}${sessionLease.owner}`, id: sessionLease.id };
      const result = await proxy.create(url, { embedderOrigins: chain, lease, tunneled: true });
      if (!result.ok) {
        proxy.release(lease.owner, lease.id);
        return { refused: result.detail ?? result.reason };
      }
      const framed = new URL(result.url);
      return new GrantUpstream(origin, framed, () => proxy.release(lease.owner, lease.id));
    },
  };
}

class GrantUpstream implements FrameUpstream {
  readonly path: string;
  readonly #frameOrigin: string;
  /** The grant's own origin, `http://127.0.0.1:<port>`. */
  readonly #grantOrigin: string;
  readonly #port: number;
  readonly #agent = new http.Agent({ keepAlive: true });
  readonly #live = new Set<{ abort(): void }>();
  readonly #release: () => void;
  #closed = false;

  constructor(frameOrigin: string, framed: URL, release: () => void) {
    this.#frameOrigin = frameOrigin;
    this.#grantOrigin = framed.origin;
    this.#port = Number(framed.port);
    this.path = `${framed.pathname}${framed.search}${framed.hash}`;
    this.#release = release;
  }

  request(init: FrameHttpInit, sink: FrameHttpSink): FrameHttpExchange {
    const exchange = new GrantExchange(this.#translate(init), sink, this.#grantOrigin, () => {
      this.#live.delete(exchange);
    });
    if (this.#closed) exchange.abort();
    else this.#live.add(exchange);
    return exchange;
  }

  openSocket(init: FrameSocketInit, sink: FrameSocketSink): FrameSocket {
    // A framed page's own socket always comes from the frame origin, so the
    // grant is told its own: the proxy relabels that, and only that, as the
    // upstream's (`docs/specs/security-local.md` → "Loopback Listeners").
    const socket = new GrantSocket(`ws://127.0.0.1:${this.#port}${init.path}`, init.protocols, this.#grantOrigin, sink, () => {
      this.#live.delete(socket);
    });
    if (this.#closed) socket.terminate();
    else this.#live.add(socket);
    return socket;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const live of [...this.#live]) live.abort();
    this.#live.clear();
    this.#agent.destroy();
    this.#release();
  }

  /** The request a loopback caller at the grant's own origin would have made. */
  #translate(init: FrameHttpInit): http.RequestOptions {
    const headers: Record<string, string | string[]> = {};
    for (const [rawName, rawValue] of init.headers) {
      const name = rawName.toLowerCase();
      if (DROPPED_REQUEST_HEADERS.has(name) || name.startsWith('sec-') || name.startsWith('proxy-')) continue;
      let value = rawValue;
      if (name === 'origin' && value === this.#frameOrigin) value = this.#grantOrigin;
      if (name === 'referer') value = rewriteOrigin(value, this.#frameOrigin, this.#grantOrigin);
      const prior = headers[name];
      headers[name] = prior === undefined ? value : [...(Array.isArray(prior) ? prior : [prior]), value];
    }
    headers.host = `127.0.0.1:${this.#port}`;
    // A body the tunnel can hand on as it came; the proxy decodes one sent compressed
    // regardless.
    headers['accept-encoding'] = 'identity';
    if (init.destination !== undefined) headers['sec-fetch-dest'] = init.destination || 'empty';
    return {
      host: '127.0.0.1',
      port: this.#port,
      method: init.method,
      path: init.path,
      headers,
      agent: this.#agent,
    };
  }
}

class GrantExchange implements FrameHttpExchange {
  /** `null` when Node refused to build the request at all. */
  readonly #request: http.ClientRequest | null;
  readonly #sink: FrameHttpSink;
  readonly #grantOrigin: string;
  readonly #done: () => void;
  #body: Readable | null = null;
  #paused = false;
  #finished = false;
  /** Writes not yet settled: Node may never call back on a request it destroyed. */
  readonly #writing = new Set<(error?: Error | null) => void>();

  constructor(options: http.RequestOptions, sink: FrameHttpSink, grantOrigin: string, done: () => void) {
    this.#sink = sink;
    this.#grantOrigin = grantOrigin;
    this.#done = done;
    let request: http.ClientRequest | null = null;
    try {
      request = http.request(options);
    } catch (error) {
      // A field Node will not put on the wire: the Client still hears why, once
      // its exchange is installed.
      const message = messageOf(error);
      queueMicrotask(() => this.#fail(message));
    }
    this.#request = request;
    if (!request) return;
    request.on('response', (response) => this.#respond(response));
    request.on('error', (error) => this.#fail(error.message));
    request.setTimeout(GRANT_IDLE_TIMEOUT_MS, () => request.destroy(new Error('the embedded page timed out')));
  }

  write(chunk: Uint8Array, end: boolean): Promise<void> {
    const request = this.#request;
    if (this.#finished || !request) return Promise.reject(new Error('request closed'));
    return new Promise((resolve, reject) => {
      const settle = (error?: Error | null) => {
        this.#writing.delete(settle);
        if (error) reject(error);
        else resolve();
      };
      this.#writing.add(settle);
      if (end) {
        if (chunk.length > 0) request.write(chunk);
        request.end(settle);
      } else {
        request.write(chunk, settle);
      }
    });
  }

  pause(): void {
    this.#paused = true;
    this.#body?.pause();
  }

  resume(): void {
    this.#paused = false;
    this.#body?.resume();
  }

  abort(): void {
    if (this.#finished) return;
    this.#finish();
    this.#request?.destroy();
    this.#body?.destroy();
  }

  #finish(): void {
    this.#finished = true;
    this.#done();
    for (const settle of this.#writing) settle(new Error('request closed'));
  }

  #respond(response: http.IncomingMessage): void {
    if (this.#finished) {
      response.destroy();
      return;
    }
    const headers: HttpHeader[] = [];
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      const name = response.rawHeaders[index]!;
      const lower = name.toLowerCase();
      let value = response.rawHeaders[index + 1]!;
      // The proxy already keeps a redirect on its grant; on the Client the
      // grant is the frame origin, so the redirect stays there too.
      if (lower === 'location') value = rewriteOrigin(value, this.#grantOrigin, '');
      headers.push([name, value]);
    }
    this.#body = response;
    this.#sink.onHead(response.statusCode ?? 502, response.statusMessage ?? '', headers);
    if (this.#finished) return;
    response.on('data', (chunk: Buffer) => {
      if (!this.#finished) this.#sink.onBody(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    });
    response.on('end', () => {
      if (this.#finished) return;
      this.#finish();
      this.#sink.onEnd();
    });
    response.on('error', (error: Error) => this.#fail(error.message));
    if (this.#paused) response.pause();
  }

  #fail(message: string): void {
    if (this.#finished) return;
    this.abort();
    this.#sink.onError(message);
  }
}

class GrantSocket implements FrameSocket {
  readonly #socket: WebSocket;
  readonly #sink: FrameSocketSink;
  readonly #done: () => void;
  #paused = false;
  #finished = false;

  constructor(url: string, protocols: readonly string[], origin: string, sink: FrameSocketSink, done: () => void) {
    this.#sink = sink;
    this.#done = done;
    this.#socket = new WebSocket(url, [...protocols], {
      origin,
      perMessageDeflate: false,
      maxPayload: MAX_WS_MESSAGE_BYTES,
      handshakeTimeout: GRANT_IDLE_TIMEOUT_MS,
    });
    this.#socket.on('open', () => {
      if (this.#finished) return;
      // `ws` ignores a pause before the open.
      if (this.#paused) this.#socket.pause();
      this.#sink.onOpen(this.#socket.protocol, this.#socket.extensions);
    });
    this.#socket.on('message', (data: WebSocket.RawData, binary: boolean) => {
      if (!this.#finished) this.#sink.onMessage(toBytes(data), binary);
    });
    this.#socket.on('close', (code: number, reason: Buffer) => this.#end(code, reason.toString('utf8')));
    // A close always follows an error; the code says what happened.
    this.#socket.on('error', () => {});
  }

  send(data: Uint8Array, binary: boolean): Promise<void> {
    if (this.#finished || this.#socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('socket closed'));
    return new Promise((resolve, reject) => {
      this.#socket.send(data, { binary }, (error) => (error ? reject(error) : resolve()));
    });
  }

  close(code?: number, reason?: string): void {
    if (this.#finished) return;
    this.#socket.close(code, reason);
  }

  pause(): void {
    this.#paused = true;
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.pause();
  }

  resume(): void {
    this.#paused = false;
    if (this.#socket.readyState === WebSocket.OPEN) this.#socket.resume();
  }

  terminate(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#done();
    this.#socket.terminate();
  }

  abort(): void {
    this.terminate();
  }

  #end(code: number, reason: string): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#done();
    this.#sink.onClose(code, reason);
  }
}

function toBytes(data: WebSocket.RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
